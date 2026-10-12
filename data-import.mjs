/** Local-only aggregate CSV import. No network access or external dependencies. */
export const IMPORT_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, rows: 20_000, channels: 50, channelLength: 80, days: 366 });
export const DATASET_VERSION = 'aggregate-csv-v1:transparent-rules-v2';

const FIELDS = Object.freeze(['date', 'channel', 'count', 'overdue']);
const DAY_MS = 86_400_000;
const MAX_MESSAGES = 100;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function collector() {
  const entries = [];
  let count = 0;
  return {
    add(item) { count += 1; if (entries.length < MAX_MESSAGES) entries.push(item); },
    get count() { return count; },
    finish() {
      if (count <= MAX_MESSAGES) return entries;
      return [...entries.slice(0, MAX_MESSAGES - 1), {
        code: 'additional_messages', message: `另外 ${count - MAX_MESSAGES + 1} 条提示未展开，请修复已列问题后重新导入。`,
      }];
    },
  };
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

/** Strict CSV quoting; line numbers always refer to physical source lines. */
function readRecords(text, issues) {
  const records = [];
  let fields = [], field = '', line = 1, row = 1, quoted = false, closed = false, touched = false;
  const finishField = () => { fields.push(field); field = ''; closed = false; };
  const finishRecord = () => {
    finishField();
    records.push({ values: fields, row });
    fields = [];
    touched = false;
    if (records.length > IMPORT_LIMITS.rows + 1) {
      issues.add({ code: 'row_limit', row, message: `数据最多 ${IMPORT_LIMITS.rows} 行；请按日期拆分文件后重新导入。` });
      return false;
    }
    return true;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; closed = true; }
      } else if (char === '\r' || char === '\n') {
        field += '\n';
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        line += 1;
      } else field += char;
      continue;
    }
    if (closed && char !== ',' && char !== '\r' && char !== '\n') {
      issues.add({ code: 'csv_syntax', row: line, message: `第 ${line} 行引号闭合后存在多余字符；闭合引号后只能接逗号或换行。` });
      return null;
    }
    if (char === '"') {
      if (field !== '') {
        issues.add({ code: 'csv_syntax', row: line, message: `第 ${line} 行字段中的双引号未正确转义；请将整个字段用双引号包裹，并将内部双引号写为两个双引号。` });
        return null;
      }
      quoted = true;
      touched = true;
    } else if (char === ',') { finishField(); touched = true; }
    else if (char === '\r' || char === '\n') {
      if (!finishRecord()) return null;
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      line += 1;
      row = line;
    } else { field += char; touched = true; }
  }
  if (quoted) {
    issues.add({ code: 'unclosed_quote', row, message: `第 ${row} 行开始的字段双引号未闭合；请补齐结尾双引号。` });
    return null;
  }
  if (touched || fields.length || closed) { if (!finishRecord()) return null; }
  return records;
}

function fingerprint(rows) {
  // Two independently seeded 32-bit FNV-1a hashes. This is an identity hint,
  // not encryption, a signature, or protection against adversarial collisions.
  const normalized = `${DATASET_VERSION}\n${JSON.stringify(rows.map(({ date, channel, count, overdue }) => [date, channel, count, overdue]))}`;
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const byte of new TextEncoder().encode(normalized)) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x01000193) >>> 0;
  }
  return `csv-v1-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

const emptySummary = () => ({ rowCount: 0, channelCount: 0, totalCount: 0, totalOverdue: 0,
  dateStart: null, dateEnd: null, missingDates: [], zeroCountRows: 0, channels: [] });

/**
 * Invalid files never return runnable rows or a fingerprint. summary describes
 * individually valid rows only and must not be used to analyze invalid files.
 */
export function parseDataset(text, { name = '导入数据' } = {}) {
  const issues = collector(), warnings = collector();
  const summary = emptySummary();
  const rows = [];
  const finish = () => ({ status: issues.count ? 'invalid' : 'valid', name: String(name),
    rows: issues.count ? [] : rows, issues: issues.finish(), warnings: warnings.finish(),
    issueCount: issues.count, warningCount: warnings.count, summary,
    fingerprint: issues.count ? null : fingerprint(rows) });
  if (typeof text !== 'string') {
    issues.add({ code: 'invalid_input', message: '请读取 UTF-8 编码的 CSV 文本后导入。' });
    return finish();
  }
  if (text.length > IMPORT_LIMITS.bytes || new TextEncoder().encode(text).byteLength > IMPORT_LIMITS.bytes) {
    issues.add({ code: 'file_size', message: 'CSV 文件不得超过 2 MiB；请按日期拆分，或删除无关列后重新导入。' });
    return finish();
  }
  const records = readRecords(text.replace(/^\uFEFF/, ''), issues);
  if (!records) return finish();
  if (!records.length) {
    issues.add({ code: 'empty_data', message: '文件为空；请提供表头 date,channel,count,overdue 和至少一行数据。' });
    return finish();
  }
  const headers = records[0].values.map((value) => value.trim());
  const seenHeaders = new Set();
  for (const field of headers) {
    if (!field) issues.add({ code: 'empty_header', row: 1, message: '表头含空列名；请补齐列名或删除该列。' });
    else if (seenHeaders.has(field)) issues.add({ code: 'duplicate_header', row: 1, field, message: `列名 ${field} 重复；每个列名只能出现一次。` });
    else if (!FIELDS.includes(field)) warnings.add({ code: 'unknown_column', row: 1, field, message: `未使用列 ${field} 将被忽略；分析只读取 date、channel、count、overdue。` });
    seenHeaders.add(field);
  }
  for (const field of FIELDS) {
    if (!seenHeaders.has(field)) issues.add({ code: 'missing_header', row: 1, field, message: `缺少必填列 ${field}；请使用表头 date,channel,count,overdue（顺序可调整）。` });
  }
  if (records.length === 1) issues.add({ code: 'empty_data', message: '文件只有表头；请添加至少一行聚合数据。' });
  if (issues.count) return finish();
  const positions = Object.fromEntries(FIELDS.map((field) => [field, headers.indexOf(field)]));
  const seenKeys = new Map(), channels = new Set(), dates = new Map();
  let totalsUnsafe = false;
  for (const record of records.slice(1)) {
    const { row } = record;
    if (record.values.length !== headers.length) {
      issues.add({ code: 'column_count', row, message: `第 ${row} 行有 ${record.values.length} 列，表头有 ${headers.length} 列；请补齐字段，含逗号的渠道名称应使用双引号包裹。` });
      continue;
    }
    const raw = Object.fromEntries(FIELDS.map((field) => [field, record.values[positions[field]].trim()]));
    const before = issues.count;
    if (parseDate(raw.date) === null) issues.add({ code: 'invalid_date', row, field: 'date', message: `第 ${row} 行 date 必须是真实日期，格式为 YYYY-MM-DD，例如 2026-07-01。` });
    if (!raw.channel) issues.add({ code: 'empty_channel', row, field: 'channel', message: `第 ${row} 行 channel 不能为空；请填写稳定、匿名的渠道名称。` });
    else if (raw.channel.length > IMPORT_LIMITS.channelLength) issues.add({ code: 'channel_length', row, field: 'channel', message: `第 ${row} 行渠道名称超过 ${IMPORT_LIMITS.channelLength} 个字符；请缩短为稳定、匿名的渠道名称（部分表情按两个字符计）。` });
    else if (/^[=+\-@]/.test(raw.channel) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.channel)) {
      issues.add({ code: 'unsafe_channel', row, field: 'channel', message: `第 ${row} 行渠道名含公式前缀（=、+、-、@）或控制字符；请改为普通渠道名称，避免导出后被表格软件当作公式。` });
    }
    for (const field of ['count', 'overdue']) {
      if (!/^\d+$/.test(raw[field]) || !Number.isSafeInteger(Number(raw[field]))) {
        issues.add({ code: 'invalid_integer', row, field, message: `第 ${row} 行 ${field} 必须是 0 至 ${Number.MAX_SAFE_INTEGER} 的整数；不接受空值、负数、小数、千分位、NaN 或科学计数法。` });
      }
    }
    if (issues.count !== before) continue;
    const item = { date: raw.date, channel: raw.channel, count: Number(raw.count), overdue: Number(raw.overdue) };
    if (item.overdue > item.count) {
      issues.add({ code: 'overdue_exceeds_count', row, field: 'overdue', message: `第 ${row} 行 overdue（${item.overdue}）大于 count（${item.count}）；请核对分子分母口径，count 为 0 时 overdue 也必须为 0。` });
      continue;
    }
    const key = JSON.stringify([item.date, item.channel]);
    if (seenKeys.has(key)) {
      issues.add({ code: 'duplicate_record', row, message: `第 ${row} 行与第 ${seenKeys.get(key)} 行的日期和渠道重复；请先按 date + channel 汇总，每组仅保留一行。` });
      continue;
    }
    seenKeys.set(key, row);
    rows.push(item);
    channels.add(item.channel);
    if (!dates.has(item.date)) dates.set(item.date, new Set());
    dates.get(item.date).add(item.channel);
    if (item.count === 0) summary.zeroCountRows += 1;
    if (!Number.isSafeInteger(summary.totalCount + item.count) || !Number.isSafeInteger(summary.totalOverdue + item.overdue)) totalsUnsafe = true;
    summary.totalCount += item.count;
    summary.totalOverdue += item.overdue;
  }
  rows.sort((a, b) => compare(a.date, b.date) || compare(a.channel, b.channel));
  summary.rowCount = rows.length;
  summary.channels = [...channels].sort(compare);
  summary.channelCount = channels.size;
  summary.dateStart = rows[0]?.date ?? null;
  summary.dateEnd = rows.at(-1)?.date ?? null;
  if (channels.size > IMPORT_LIMITS.channels) issues.add({ code: 'channel_limit', field: 'channel', message: `检测到 ${channels.size} 个渠道，最多支持 ${IMPORT_LIMITS.channels} 个；请合并或筛选渠道后重新导入。` });
  if (totalsUnsafe) {
    summary.totalCount = null;
    summary.totalOverdue = null;
    issues.add({ code: 'unsafe_total', message: '全表 count 或 overdue 合计超过 JavaScript 安全整数范围；请缩小数据范围，避免汇总精度丢失。' });
  }
  if (summary.dateStart) {
    const start = parseDate(summary.dateStart), end = parseDate(summary.dateEnd);
    const days = (end - start) / DAY_MS + 1;
    if (days > IMPORT_LIMITS.days) issues.add({ code: 'date_span', field: 'date', message: `数据日期跨度为 ${days} 天，最多支持 ${IMPORT_LIMITS.days} 天；请按年度或更短周期拆分。` });
    else {
      for (let day = start; day <= end; day += DAY_MS) {
        const date = new Date(day).toISOString().slice(0, 10);
        if (!dates.has(date)) {
          summary.missingDates.push(date);
          warnings.add({ code: 'missing_day', field: 'date', message: `${date} 没有记录；缺失日期不会视为零，包含该日的分析窗口需要先补齐数据。` });
        } else {
          const missing = summary.channels.filter((channel) => !dates.get(date).has(channel));
          if (missing.length) warnings.add({ code: 'missing_channel_day', field: 'channel', message: `${date} 缺少渠道：${missing.join('、')}。不会自动补零；请确认是否未报送，零业务也应显式提供 count=0、overdue=0。` });
        }
      }
    }
  }
  if (summary.zeroCountRows) warnings.add({ code: 'zero_count_rows', field: 'count', message: `${summary.zeroCountRows} 行 count 为 0；这表示显式零样本，不等于缺失数据，不能单独计算逾期率。` });
  return finish();
}

/** Export only validated, spreadsheet-safe records; importing again is lossless. */
export function toCsv(rows) {
  if (!Array.isArray(rows)) throw new TypeError('CSV 导出需要聚合数据行数组。');
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = [FIELDS.join(','), ...rows.map((row) => FIELDS.map((field) => escape(row?.[field])).join(','))].join('\r\n') + '\r\n';
  const validation = parseDataset(csv);
  if (validation.status !== 'valid') throw new TypeError(`CSV 导出失败：${validation.issues[0].message}`);
  return csv;
}
