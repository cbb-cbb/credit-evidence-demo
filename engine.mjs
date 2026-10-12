/**
 * A standalone, deterministic synthetic-data demonstration.
 * No network, LLM, historical-case lookup, customer data or upstream source code.
 * Rates are pooled loan-weighted rates; every generated outcome is assumed mature.
 */

const DAY_MS = 86_400_000;
const CHANNELS = Object.freeze(['A', 'B', 'C']);

export const DATA_COVERAGE = Object.freeze({
  start: '2026-06-01',
  end: '2026-07-30',
  days: 60,
  channels: CHANNELS,
});

export const DEFAULT_PERIODS = Object.freeze({
  baseline: Object.freeze({ start: '2026-06-01', end: '2026-07-19' }),
  anomaly: Object.freeze({ start: '2026-07-20', end: '2026-07-30' }),
});

export const scenarios = Object.freeze([
  Object.freeze({
    id: 'channel-mix',
    name: '渠道 C 放量',
    description: '7 月 20 日起，高风险渠道 C 的占比上升；各渠道自身逾期率大致稳定。',
    expectedOutcome: '渠道结构变化是优先核查线索，仍不能据此证明业务因果。',
  }),
  Object.freeze({
    id: 'stable',
    name: '稳定对照',
    description: '渠道结构和各渠道风险均保持稳定，只有小幅确定性波动。',
    expectedOutcome: '不应因为用户说有异常，就强行给出异常归因。',
  }),
  Object.freeze({
    id: 'broad-risk',
    name: '全渠道风险上升',
    description: '7 月 20 日起，各渠道自身逾期率同时上升，渠道结构大致稳定。',
    expectedOutcome: '优先排查共同因素；这些聚合数据不能判断具体是模型还是审批原因。',
  }),
]);

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

function datesBetween(start, end) {
  const dates = [];
  for (let time = parseDate(start); time <= parseDate(end); time += DAY_MS) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** @returns {{date:string,channel:string,count:number,overdue:number}[]} */
export function generateData(scenarioId = 'channel-mix') {
  if (!scenarios.some((scenario) => scenario.id === scenarioId)) {
    throw new RangeError(`未知合成场景：${scenarioId}`);
  }
  // Shared seed means all scenarios have the exact same baseline and daily volume.
  const random = seededRandom(20260601);
  return datesBetween(DATA_COVERAGE.start, DATA_COVERAGE.end).flatMap((date) => {
    const afterChange = date >= '2026-07-20';
    const changedMix = afterChange && scenarioId === 'channel-mix';
    const total = 280 + Math.floor(random() * 230);
    const shareA = (changedMix ? 0.40 : 0.49) + (random() - 0.5) * 0.012;
    const shareB = (changedMix ? 0.31 : 0.43) + (random() - 0.5) * 0.012;
    const counts = [Math.floor(total * shareA), Math.floor(total * shareB)];
    counts.push(total - counts[0] - counts[1]);
    return CHANNELS.map((channel, index) => {
      const baseRate = [0.12, 0.145, 0.237][index];
      const shift = afterChange && scenarioId === 'broad-risk' ? 0.06 : 0;
      const rate = baseRate + shift + (random() - 0.5) * 0.008;
      return { date, channel, count: counts[index], overdue: Math.round(counts[index] * rate) };
    });
  });
}

function summarize(rows) {
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  const overdue = rows.reduce((sum, row) => sum + row.overdue, 0);
  return { count, overdue, rate: count > 0 ? overdue / count : null, days: new Set(rows.map((row) => row.date)).size };
}

const percent = (value) => `${(value * 100).toFixed(2)}%`;
const pp = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} 个百分点`;

/**
 * Run the actual four transparent rules synchronously against generated rows.
 * Missing/partial date coverage blocks before rules; no historical clues are used.
 * Every rate and share is a fraction; *Pp fields are percentage points.
 */
export function analyze({ scenarioId = 'channel-mix', baseline, anomaly } = {}) {
  const result = {
    status: 'blocked',
    mode: 'transparent_rules',
    dataSource: 'synthetic',
    scenarioId,
    coverage: DATA_COVERAGE,
    periods: { baseline, anomaly },
    message: '',
    issues: [],
    metrics: null,
    channels: [],
    evidence: [],
    candidates: [],
    conclusion: null,
    decomposition: null,
    checksExecuted: 0,
    assumptions: [
      '全部为确定性生成的聚合合成数据，不包含真实客户或前雇主数据。',
      '合成逾期结果假设已完成观察期；真实业务还需要逐笔验证样本成熟度。',
      '规则阈值用于解释演示，未通过真实数据校准；统计关联不能证明业务因果。',
    ],
  };
  const issue = (field, code, message) => result.issues.push({ field, code, message });
  const blocked = () => {
    result.message = result.issues.map((item) => item.message).join(' ');
    return result;
  };

  if (!scenarios.some((scenario) => scenario.id === scenarioId)) {
    issue('scenarioId', 'unknown_scenario', '请选择可用的合成场景。');
  }
  for (const [key, period, label] of [['baseline', baseline, '正常对比期'], ['anomaly', anomaly, '异常期']]) {
    for (const [bound, name] of [['start', '开始日期'], ['end', '结束日期']]) {
      if (parseDate(period?.[bound]) === null) {
        issue(`${key}.${bound}`, 'invalid_date', `${label}${name}必须是有效日期（YYYY-MM-DD）。`);
      }
    }
    if (parseDate(period?.start) !== null && parseDate(period?.end) !== null && period.start > period.end) {
      issue(key, 'reversed_period', `${label}的开始日期不能晚于结束日期。`);
    }
  }
  if (result.issues.length) return blocked();
  if (baseline.end >= anomaly.start) {
    issue('periods', 'overlapping_or_reversed_periods', '正常对比期须完整早于异常期，两期不能重叠。');
    return blocked();
  }

  const rows = generateData(scenarioId);
  const observedDates = new Set(rows.map((row) => row.date));
  const selected = {};
  for (const [key, period, label] of [['baseline', baseline, '正常对比期'], ['anomaly', anomaly, '异常期']]) {
    // Avoid expanding unbounded user date ranges; any out-of-range endpoint proves incomplete coverage.
    if (period.start < DATA_COVERAGE.start || period.end > DATA_COVERAGE.end) {
      const whollyMissing = period.end < DATA_COVERAGE.start || period.start > DATA_COVERAGE.end;
      issue(key, whollyMissing ? 'missing_data' : 'partial_coverage',
        `${label} ${period.start} 至 ${period.end} ${whollyMissing ? '没有数据' : '未被数据完整覆盖'}；可用日期为 ${DATA_COVERAGE.start} 至 ${DATA_COVERAGE.end}。请调整日期后重新检查。`);
      continue;
    }
    const requestedDates = datesBetween(period.start, period.end);
    if (requestedDates.some((date) => !observedDates.has(date))) {
      issue(key, 'partial_coverage', `${label}存在缺失日期，请补全数据后重新检查。`);
      continue;
    }
    selected[key] = rows.filter((row) => row.date >= period.start && row.date <= period.end);
    if (!summarize(selected[key]).count) {
      issue(key, 'empty_sample', `${label}没有可用样本，不能将空样本解释为零逾期率。`);
    }
  }
  if (result.issues.length) return blocked();

  const baselineSummary = summarize(selected.baseline);
  const anomalySummary = summarize(selected.anomaly);
  const deltaPp = (anomalySummary.rate - baselineSummary.rate) * 100;
  result.metrics = { baseline: baselineSummary, anomaly: anomalySummary, deltaPp };
  result.channels = CHANNELS.map((channel) => {
    const before = summarize(selected.baseline.filter((row) => row.channel === channel));
    const after = summarize(selected.anomaly.filter((row) => row.channel === channel));
    before.share = before.count / baselineSummary.count;
    after.share = after.count / anomalySummary.count;
    return {
      channel,
      baseline: before,
      anomaly: after,
      shareDeltaPp: (after.share - before.share) * 100,
      rateDeltaPp: (after.rate - before.rate) * 100,
    };
  });

  // Symmetric rate decomposition: total change = composition change + within-channel change.
  const compositionPp = result.channels.reduce((sum, channel) => sum +
    (channel.anomaly.share - channel.baseline.share) * (channel.baseline.rate + channel.anomaly.rate) / 2 * 100, 0);
  const withinChannelPp = result.channels.reduce((sum, channel) => sum +
    (channel.anomaly.rate - channel.baseline.rate) * (channel.baseline.share + channel.anomaly.share) / 2 * 100, 0);
  result.decomposition = { compositionPp, withinChannelPp, totalPp: deltaPp };

  const overallRise = deltaPp >= 1;
  const mixChannels = result.channels.filter((channel) => {
    const otherCount = baselineSummary.count - channel.baseline.count;
    const otherRate = (baselineSummary.overdue - channel.baseline.overdue) / otherCount;
    return channel.shareDeltaPp >= 5 && channel.baseline.rate - otherRate >= 0.02;
  });
  const mixShift = overallRise && mixChannels.length > 0 && compositionPp >= 1;
  const broadShift = overallRise && result.channels.every((channel) => channel.rateDeltaPp >= 2);
  const stable = Math.abs(deltaPp) < 1 && result.channels.every((channel) =>
    Math.abs(channel.rateDeltaPp) < 2 && Math.abs(channel.shareDeltaPp) < 5);
  result.checksExecuted = 4;

  result.evidence = [
    {
      id: 'overall-rate', label: '整体逾期率变化', kind: overallRise ? 'support' : 'context',
      detail: `正常对比期 ${baselineSummary.overdue}/${baselineSummary.count} = ${percent(baselineSummary.rate)}；异常期 ${anomalySummary.overdue}/${anomalySummary.count} = ${percent(anomalySummary.rate)}，变化 ${pp(deltaPp)}。整体上升规则阈值为至少 1 个百分点。`,
      values: { baselineRate: baselineSummary.rate, anomalyRate: anomalySummary.rate, deltaPp, thresholdPp: 1 },
    },
    {
      id: 'channel-mix', label: '渠道结构与风险', kind: mixShift ? 'support' : 'counter',
      detail: mixShift
        ? `${mixChannels.map((channel) => `渠道 ${channel.channel} 占比从 ${percent(channel.baseline.share)} 升至 ${percent(channel.anomaly.share)}，其基准逾期率为 ${percent(channel.baseline.rate)}`).join('；')}。满足占比增加至少 5 个百分点且基准风险高于其他渠道至少 2 个百分点的规则。`
        : '未同时满足“整体上升、较高风险渠道占比增加至少 5 个百分点、结构项贡献至少 1 个百分点”的规则；不能优先归因为渠道放量。',
      values: { matchedChannels: mixChannels.map((channel) => channel.channel), compositionPp },
    },
    {
      id: 'within-channel', label: '各渠道自身风险变化', kind: broadShift ? 'support' : 'context',
      detail: `${result.channels.map((channel) => `渠道 ${channel.channel} ${pp(channel.rateDeltaPp)}`).join('；')}。${broadShift ? '所有渠道均上升至少 2 个百分点，符合共同风险上升线索。' : '未达到所有渠道均上升至少 2 个百分点的阈值。'}`,
      values: { thresholdPp: 2, broadShift },
    },
    {
      id: 'stable-control', label: '稳定性检查', kind: stable ? 'counter' : 'context',
      detail: stable
        ? '整体变化小于 1 个百分点，各渠道自身变化小于 2 个百分点、份额变化小于 5 个百分点；未观察到超过本演示阈值的明显变化。此检查不等同于统计显著性检验。'
        : '当前比较不满足稳定对照规则，需要结合其他证据理解变化。规则不等同于统计显著性检验。',
      values: { stable },
    },
  ];

  const candidate = (id, label, assessment, reason, evidenceIds) => ({ id, label, assessment, reason, evidenceIds });
  if (mixShift) {
    result.candidates.push(candidate('channel-mix', '优先核查渠道结构变化', '数据支持这一线索',
      `结构变化项为 ${pp(compositionPp)}，各渠道内部变化项为 ${pp(withinChannelPp)}。这是聚合率变化的数学分解，不能据此证明渠道投放造成了风险。`, ['overall-rate', 'channel-mix']));
  }
  if (broadShift) {
    result.candidates.push(candidate('broad-risk', '优先核查跨渠道共同因素', '数据支持这一线索',
      '各渠道自身风险均上升。需进一步检查样本结构、观察期、审批口径和外部环境；现有字段无法区分这些原因。', ['overall-rate', 'within-channel']));
  }
  if (stable) {
    result.candidates.push(candidate('stable', '未观察到明显异常', '当前数据不支持强行归因',
      '当前两期差异未超过演示规则阈值。应先核实业务异常定义，再决定是否扩大样本或细化分析。', ['overall-rate', 'stable-control']));
  }
  if (!result.candidates.length) {
    result.candidates.push(candidate('unresolved', '现有规则无法给出明确线索', '需要进一步核查',
      '已有差异没有完整满足渠道放量、全渠道风险上升或稳定对照规则。请查看明细，不应把规则未命中解释为没有任何业务风险。', ['overall-rate', 'channel-mix', 'within-channel']));
  }
  result.candidates.push(candidate('model-or-policy', '模型失效或审批标准改变', '现有字段不足以判断',
    '本演示没有预测分数、模型版本、AUC/KS、审批阈值或策略变更记录；仅凭逾期率不能确认这些原因。', []));
  const primary = result.candidates[0];
  result.conclusion = { id: primary.id, label: primary.label, summary: primary.reason };
  result.status = 'ready';
  result.message = '数据覆盖检查通过，已完成 4 项透明规则检查。';
  return result;
}
