import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDataset, toCsv, IMPORT_LIMITS } from '../data-import.mjs';

const header = 'date,channel,count,overdue';
const valid = `${header}\n2026-07-01,渠道甲,100,10\n2026-07-02,渠道甲,120,15\n`;
const hasIssue = (result, code) => result.issues.some((issue) => issue.code === code);

test('UTF-8 BOM, CRLF, reordered columns, extra columns and Chinese names import correctly', () => {
  const result = parseDataset('\uFEFFoverdue,channel,ignored,count,date\r\n15,渠道甲,note,120,2026-07-02\r\n10,渠道甲,note,100,2026-07-01\r\n', { name: '我的文件.csv' });
  assert.equal(result.status, 'valid');
  assert.equal(result.name, '我的文件.csv');
  assert.deepEqual(result.rows, [
    { date: '2026-07-01', channel: '渠道甲', count: 100, overdue: 10 },
    { date: '2026-07-02', channel: '渠道甲', count: 120, overdue: 15 },
  ]);
  assert.deepEqual(result.summary, {
    rowCount: 2, channelCount: 1, totalCount: 220, totalOverdue: 25,
    dateStart: '2026-07-01', dateEnd: '2026-07-02', missingDates: [], zeroCountRows: 0, channels: ['渠道甲'],
  });
  assert.equal(result.warnings[0].code, 'unknown_column');
  assert.equal(result.issueCount, 0);
});

test('quoted fields support commas, escaped quotes and embedded CRLF normalized to LF', () => {
  const source = `${header}\r\n2026-07-01,"渠道,\"\"甲\"\"\r\n分部",100,10\r\n2026-07-02,"渠道,\"\"甲\"\"\n分部",100,10`;
  const result = parseDataset(source);
  assert.equal(result.status, 'valid');
  assert.equal(result.rows[0].channel, '渠道,"甲"\n分部');
  assert.equal(result.summary.channelCount, 1);
  assert.deepEqual(parseDataset(toCsv(result.rows)).rows, result.rows);
});

test('physical line numbers remain correct after multiline quoted fields', () => {
  const result = parseDataset(`${header}\n2026-07-01,"渠道\n甲",100,10\n2026-07-02,渠道乙,-1,0\n`);
  assert.equal(result.status, 'invalid');
  assert.equal(result.issues.find((issue) => issue.code === 'invalid_integer').row, 4);
});

test('CSV syntax errors reject the complete dataset with actionable line information', async (t) => {
  for (const [name, row, code] of [
    ['unclosed quote', '2026-07-01,"渠道甲,100,10', 'unclosed_quote'],
    ['quote in bare field', '2026-07-01,渠"道甲,100,10', 'csv_syntax'],
    ['characters after quote', '2026-07-01,"渠道甲"x,100,10', 'csv_syntax'],
    ['missing column', '2026-07-01,渠道甲,100', 'column_count'],
    ['extra column', '2026-07-01,渠道甲,100,10,extra', 'column_count'],
    ['blank internal line', '\n2026-07-01,渠道甲,100,10', 'column_count'],
  ]) {
    await t.test(name, () => {
      const result = parseDataset(`${header}\n${row}`);
      assert.equal(result.status, 'invalid');
      assert.deepEqual(result.rows, []);
      assert.equal(result.fingerprint, null);
      assert.ok(hasIssue(result, code));
      assert.equal(result.issues.find((issue) => issue.code === code).row, 2);
    });
  }
});

test('empty data, missing headers and duplicate headers are not silently accepted', async (t) => {
  for (const [text, code] of [
    ['', 'empty_data'], ['\uFEFF', 'empty_data'], [header, 'empty_data'],
    ['date,channel,count\n2026-07-01,A,100', 'missing_header'],
    ['date,channel,count,overdue,count\n2026-07-01,A,100,10,100', 'duplicate_header'],
    ['date,channel,count,overdue,,\n2026-07-01,A,100,10,,', 'empty_header'],
    ['date,channel,count,overdue,extra,extra\n2026-07-01,A,100,10,a,b', 'duplicate_header'],
  ]) await t.test(code + JSON.stringify(text), () => {
    const result = parseDataset(text);
    assert.equal(result.status, 'invalid');
    assert.ok(hasIssue(result, code));
    assert.deepEqual(result.rows, []);
  });
  assert.ok(hasIssue(parseDataset(null), 'invalid_input'));
});

test('real calendar dates are validated, including leap days and format', async (t) => {
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-7-01', '', 'not-a-date']) {
    await t.test(date || 'blank', () => {
      assert.ok(hasIssue(parseDataset(`${header}\n${date},渠道甲,100,10`), 'invalid_date'));
    });
  }
  assert.equal(parseDataset(`${header}\n2024-02-29,渠道甲,100,10`).status, 'valid');
});

test('count and overdue require safe nonnegative integers', async (t) => {
  for (const value of ['', '-1', '1.5', 'NaN', 'Infinity', '1e3', '+1', '0x10', '9007199254740992']) {
    for (const field of ['count', 'overdue']) await t.test(`${field}=${value}`, () => {
      const row = `2026-07-01,渠道甲,${field === 'count' ? value : '100'},${field === 'overdue' ? value : '0'}`;
      const result = parseDataset(`${header}\n${row}`);
      assert.equal(result.status, 'invalid');
      assert.ok(result.issues.some((issue) => issue.code === 'invalid_integer' && issue.field === field));
    });
  }
  assert.equal(parseDataset(`${header}\n2026-07-01,渠道甲,9007199254740991,0`).status, 'valid');
});

test('valid individual integers cannot overflow aggregate totals silently', () => {
  const result = parseDataset(`${header}\n2026-07-01,甲,9007199254740991,0\n2026-07-01,乙,1,0`);
  assert.equal(result.status, 'invalid');
  assert.ok(hasIssue(result, 'unsafe_total'));
  assert.equal(result.summary.totalCount, null);
});

test('zero count is explicit zero and overdue can never exceed count', () => {
  const zero = parseDataset(`${header}\n2026-07-01,渠道甲,0,0`);
  assert.equal(zero.status, 'valid');
  assert.equal(zero.summary.zeroCountRows, 1);
  assert.equal(zero.rows[0].overdue, 0);
  for (const row of ['2026-07-01,渠道甲,0,1', '2026-07-01,渠道甲,100,101']) {
    assert.ok(hasIssue(parseDataset(`${header}\n${row}`), 'overdue_exceeds_count'));
  }
});

test('channel must be nonempty and formula-prefixed values are rejected on import and export', () => {
  assert.ok(hasIssue(parseDataset(`${header}\n2026-07-01,  ,100,10`), 'empty_channel'));
  for (const channel of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\t=1+1', '  +1', '\uFEFF@name', 'A\u0000B']) {
    assert.ok(hasIssue(parseDataset(`${header}\n2026-07-01,${channel},100,10`), 'unsafe_channel'), channel);
    assert.throws(() => toCsv([{ date: '2026-07-01', channel, count: 100, overdue: 10 }]), /公式前缀|控制字符/);
  }
});

test('duplicate date and normalized channel requires explicit aggregation', () => {
  const result = parseDataset(`${header}\n2026-07-01,渠道甲,100,10\n2026-07-01, 渠道甲 ,200,20`);
  assert.equal(result.status, 'invalid');
  const issue = result.issues.find((item) => item.code === 'duplicate_record');
  assert.equal(issue.row, 3);
  assert.match(issue.message, /第 2 行/);
  assert.deepEqual(result.rows, []);
});

test('channel names obey the same 80-character boundary as the analysis engine', () => {
  assert.equal(parseDataset(`${header}\n2026-07-01,${'渠'.repeat(80)},100,10`).status, 'valid');
  const result = parseDataset(`${header}\n2026-07-01,${'渠'.repeat(81)},100,10`);
  assert.equal(result.status, 'invalid');
  assert.ok(hasIssue(result, 'channel_length'));
  assert.equal(result.issues[0].row, 2);
  assert.equal(result.issues[0].field, 'channel');
});

test('missing dates and missing day/channel cells warn without fabricating zero records', () => {
  const result = parseDataset(`${header}\n2026-07-01,渠道甲,100,10\n2026-07-01,渠道乙,100,10\n2026-07-03,渠道甲,100,10`);
  assert.equal(result.status, 'valid');
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.summary.missingDates, ['2026-07-02']);
  assert.ok(result.warnings.some((item) => item.code === 'missing_day'));
  assert.ok(result.warnings.some((item) => item.code === 'missing_channel_day' && /渠道乙/.test(item.message)));
  assert.equal(result.summary.totalCount, 300);
});

test('fingerprints are invariant to file name, row order, column order, BOM and ignored data', () => {
  const first = parseDataset(valid, { name: 'before.csv' });
  const second = parseDataset('\uFEFFoverdue,count,date,channel,unused\r\n15,120,2026-07-02,渠道甲,"other,data"\r\n10,100,2026-07-01,渠道甲,hello\r\n', { name: 'renamed.csv' });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, parseDataset(toCsv(first.rows)).fingerprint);
  assert.match(first.fingerprint, /^csv-v1-[0-9a-f]{16}$/);
});

test('changing any analysis-relevant field isolates dataset fingerprints and reviews', () => {
  const first = parseDataset(valid);
  const changes = [valid.replace('120,15', '121,15'), valid.replace('120,15', '120,16'),
    valid.replaceAll('渠道甲', '渠道乙'), valid.replace('2026-07-02', '2026-07-03')];
  const prints = changes.map((text) => parseDataset(text).fingerprint);
  assert.ok(prints.every((value) => value !== first.fingerprint));
  assert.equal(new Set(prints).size, prints.length);
});

test('UTF-8 size limit is applied in bytes, including multibyte Chinese text', () => {
  const prefix = `${header},note\n2026-07-01,渠道甲,100,10,`;
  const prefixBytes = new TextEncoder().encode(prefix).byteLength;
  const exact = prefix + 'a'.repeat(IMPORT_LIMITS.bytes - prefixBytes);
  assert.equal(parseDataset(exact).status, 'valid');
  assert.ok(hasIssue(parseDataset(exact + 'a'), 'file_size'));
  assert.ok(hasIssue(parseDataset(prefix + '中'.repeat(IMPORT_LIMITS.bytes / 2)), 'file_size'));
});

test('data row, channel and inclusive date-span limits prevent excessive browser work', () => {
  assert.ok(hasIssue(parseDataset(`${header}\n` + '2026-07-01,A,1,0\n'.repeat(IMPORT_LIMITS.rows + 1)), 'row_limit'));
  const channels = Array.from({ length: 51 }, (_, index) => `2026-07-01,渠道${index},100,10`);
  assert.ok(hasIssue(parseDataset(`${header}\n${channels.join('\n')}`), 'channel_limit'));
  assert.equal(parseDataset(`${header}\n${channels.slice(0, 50).join('\n')}`).status, 'valid');
  assert.equal(parseDataset(`${header}\n2024-01-01,A,1,0\n2024-12-31,A,1,0`).status, 'valid');
  assert.ok(hasIssue(parseDataset(`${header}\n2024-01-01,A,1,0\n2025-01-01,A,1,0`), 'date_span'));
});

test('issues and warnings are capped at 100 while total counts and omitted count remain visible', () => {
  const errors = parseDataset(`${header}\n` + '2026-07-01,A,-1,0\n'.repeat(140));
  assert.equal(errors.issueCount, 140);
  assert.equal(errors.issues.length, 100);
  assert.equal(errors.issues.at(-1).code, 'additional_messages');
  assert.match(errors.issues.at(-1).message, /41/);
  const warnings = parseDataset(`${header}\n2024-01-01,A,1,0\n2024-12-31,A,1,0`);
  assert.equal(warnings.warningCount, 364);
  assert.equal(warnings.warnings.length, 100);
  assert.equal(warnings.summary.missingDates.length, 364);
  assert.match(warnings.warnings.at(-1).message, /265/);
});

test('CSV exporter round trips validated Chinese and escaped content and rejects invalid input', () => {
  const original = parseDataset(`${header}\n2026-07-01,"渠道,\"\"甲\"\"",100,10\n2026-07-02,"渠道,\"\"甲\"\"",0,0`);
  assert.equal(original.status, 'valid');
  const csv = toCsv(original.rows);
  assert.ok(csv.startsWith(header + '\r\n'));
  assert.deepEqual(parseDataset(csv).rows, original.rows);
  assert.throws(() => toCsv([]), /至少一行/);
  assert.throws(() => toCsv(null), /数组/);
  assert.throws(() => toCsv([{ date: '2026-07-01', channel: 'A', count: 10, overdue: 11 }]), /大于/);
});

test('downloadable examples have the stated valid, invalid and missing-day outcomes', () => {
  const example = (name) => parseDataset(readFileSync(new URL(`../examples/${name}.csv`, import.meta.url), 'utf8'));
  const good = example('valid-channel');
  assert.equal(good.status, 'valid');
  assert.equal(good.summary.rowCount, 16);
  assert.equal(good.summary.channelCount, 2);
  assert.equal(good.warnings.length, 0);
  const bad = example('invalid-quality');
  assert.equal(bad.status, 'invalid');
  assert.ok(hasIssue(bad, 'overdue_exceeds_count'));
  assert.ok(hasIssue(bad, 'invalid_integer'));
  const missing = example('missing-days');
  assert.equal(missing.status, 'valid');
  assert.deepEqual(missing.summary.missingDates, ['2026-07-03']);
});
