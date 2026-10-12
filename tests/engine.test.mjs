import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, analyzeRows, generateData, scenarios, DATA_COVERAGE, DEFAULT_PERIODS } from '../engine.mjs';

const run = (scenarioId = 'channel-mix', periods = DEFAULT_PERIODS) => analyze({ scenarioId, ...periods });

test('synthetic data is reproducible, valid and contains every day/channel', () => {
  for (const { id } of scenarios) {
    const rows = generateData(id);
    assert.deepEqual(rows, generateData(id));
    assert.equal(rows.length, 60 * 3);
    assert.equal(rows[0].date, DATA_COVERAGE.start);
    assert.equal(rows.at(-1).date, DATA_COVERAGE.end);
    assert.equal(new Set(rows.map((row) => `${row.date}/${row.channel}`)).size, rows.length);
    for (const row of rows) {
      assert.ok(Number.isInteger(row.count) && row.count > 0);
      assert.ok(Number.isInteger(row.overdue) && row.overdue >= 0 && row.overdue <= row.count);
    }
  }
});

test('scenarios share a baseline, so the deliberate intervention can be compared', () => {
  const before = (id) => generateData(id).filter((row) => row.date < '2026-07-20');
  assert.deepEqual(before('channel-mix'), before('stable'));
  assert.deepEqual(before('channel-mix'), before('broad-risk'));
});

test('channel mix story identifies structure shift without claiming model failure', () => {
  const result = run();
  assert.equal(result.status, 'ready');
  assert.equal(result.conclusion.id, 'channel-mix');
  assert.equal(result.checksExecuted, 4);
  const channelC = result.channels.find((channel) => channel.channel === 'C');
  assert.ok(channelC.shareDeltaPp > 15);
  assert.ok(Math.abs(channelC.rateDeltaPp) < 2);
  assert.ok(result.decomposition.compositionPp > result.decomposition.withinChannelPp);
  assert.equal(result.candidates.find((item) => item.id === 'model-or-policy').assessment, '现有字段不足以判断');
});

test('stable control does not force anomaly attribution', () => {
  const result = run('stable');
  assert.equal(result.conclusion.id, 'stable');
  assert.ok(Math.abs(result.metrics.deltaPp) < 1);
  assert.ok(!result.candidates.some((item) => item.id === 'channel-mix' || item.id === 'broad-risk'));
  assert.equal(result.evidence.find((item) => item.id === 'stable-control').kind, 'counter');
});

test('broad risk story distinguishes within-channel change from composition', () => {
  const result = run('broad-risk');
  assert.equal(result.conclusion.id, 'broad-risk');
  assert.ok(result.channels.every((channel) => channel.rateDeltaPp > 4));
  assert.ok(Math.abs(result.decomposition.compositionPp) < 0.5);
  assert.ok(result.decomposition.withinChannelPp > 4);
});

test('completely absent data stops before evidence rules and does not imply zero risk', () => {
  const result = run('channel-mix', {
    baseline: { start: '2026-09-01', end: '2026-09-15' },
    anomaly: { start: '2026-09-16', end: '2026-09-30' },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.checksExecuted, 0);
  assert.equal(result.metrics, null);
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every((item) => item.code === 'missing_data'));
  assert.match(result.message, /2026-06-01 至 2026-07-30/);
});

test('partially uncovered period is blocked even though some records exist', () => {
  const result = run('channel-mix', {
    baseline: { start: '2026-05-31', end: '2026-06-15' },
    anomaly: { start: '2026-07-20', end: '2026-07-31' },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.checksExecuted, 0);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every((item) => item.code === 'partial_coverage'));
});

test('invalid dates, reversed windows and overlapping windows are rejected', async (t) => {
  const cases = [
    ['impossible date', { start: '2026-02-30', end: '2026-06-19' }, DEFAULT_PERIODS.anomaly, 'invalid_date'],
    ['format', { start: '2026-6-1', end: '2026-06-19' }, DEFAULT_PERIODS.anomaly, 'invalid_date'],
    ['missing date', { end: '2026-06-19' }, DEFAULT_PERIODS.anomaly, 'invalid_date'],
    ['reversed', { start: '2026-07-02', end: '2026-06-19' }, DEFAULT_PERIODS.anomaly, 'reversed_period'],
    ['overlap', DEFAULT_PERIODS.baseline, { start: '2026-07-19', end: '2026-07-30' }, 'overlapping_or_reversed_periods'],
    ['windows reversed', DEFAULT_PERIODS.anomaly, DEFAULT_PERIODS.baseline, 'overlapping_or_reversed_periods'],
  ];
  for (const [name, baseline, anomaly, code] of cases) {
    await t.test(name, () => {
      const result = run('channel-mix', { baseline, anomaly });
      assert.equal(result.status, 'blocked');
      assert.equal(result.checksExecuted, 0);
      assert.ok(result.issues.some((item) => item.code === code));
    });
  }
});

test('window rates pool loan counts instead of averaging daily/channel ratios', () => {
  const result = run();
  for (const key of ['baseline', 'anomaly']) {
    const period = DEFAULT_PERIODS[key];
    const selected = generateData().filter((row) => row.date >= period.start && row.date <= period.end);
    const expectedCount = selected.reduce((sum, row) => sum + row.count, 0);
    const expectedOverdue = selected.reduce((sum, row) => sum + row.overdue, 0);
    const naiveMean = selected.reduce((sum, row) => sum + row.overdue / row.count, 0) / selected.length;
    assert.equal(result.metrics[key].count, expectedCount);
    assert.equal(result.metrics[key].overdue, expectedOverdue);
    assert.equal(result.metrics[key].rate, expectedOverdue / expectedCount);
    assert.ok(Math.abs(result.metrics[key].rate - naiveMean) > 0.005);
    assert.ok(Math.abs(result.channels.reduce((sum, channel) => sum + channel[key].share, 0) - 1) < 1e-12);
  }
});

test('changing subwindows truly recomputes values and can remove the anomaly', () => {
  const short = run('channel-mix', {
    baseline: { start: '2026-06-01', end: '2026-06-05' },
    anomaly: { start: '2026-06-06', end: '2026-06-10' },
  });
  assert.equal(short.status, 'ready');
  assert.equal(short.conclusion.id, 'stable');
  assert.equal(short.metrics.baseline.days, 5);
  assert.equal(short.metrics.anomaly.days, 5);
  assert.ok(short.metrics.baseline.count < run().metrics.baseline.count);
  const records = generateData().filter((row) => row.date >= '2026-06-06' && row.date <= '2026-06-10');
  assert.equal(short.metrics.anomaly.count, records.reduce((sum, row) => sum + row.count, 0));
});

test('symmetric decomposition adds up to observed total rate change', () => {
  for (const { id } of scenarios) {
    const { decomposition, metrics } = run(id);
    assert.ok(Math.abs(decomposition.compositionPp + decomposition.withinChannelPp - metrics.deltaPp) < 1e-10);
  }
});

test('unknown scene and absent input fail as validation errors', () => {
  assert.equal(run('unknown').issues[0].code, 'unknown_scenario');
  assert.equal(analyze().status, 'blocked');
  assert.throws(() => generateData('unknown'), RangeError);
});

const imported = (changes = {}) => analyzeRows({
  rows: generateData(), ...DEFAULT_PERIODS, datasetId: 'csv:test-fingerprint', datasetName: '评估样本.csv', ...changes,
});
const TWO_DAYS = {
  baseline: { start: '2026-01-01', end: '2026-01-01' },
  anomaly: { start: '2026-01-02', end: '2026-01-02' },
};
const pairRows = (counts = [[100, 100], [100, 100]]) => ['2026-01-01', '2026-01-02'].flatMap((date, index) =>
  ['A', 'B'].map((channel, channelIndex) => ({ date, channel, count: counts[index][channelIndex], overdue: Math.floor(counts[index][channelIndex] / 10) })));

test('imported aggregates show facts but pause attribution until maturity is declared', () => {
  const result = imported();
  assert.equal(result.status, 'needs_review');
  assert.equal(result.dataSource, 'imported_csv');
  assert.equal(result.datasetId, 'csv:test-fingerprint');
  assert.equal(result.datasetName, '评估样本.csv');
  assert.deepEqual(result.metrics, run().metrics);
  assert.equal(result.checksExecuted, 0);
  assert.equal(result.decomposition, null);
  assert.equal(result.conclusion.label, '先核对观察期与统计口径');
  assert.equal(result.quality.maturitySource, 'unverified');
  assert.ok(result.quality.warnings.some((item) => item.code === 'maturity_unverified'));
  assert.ok(!result.candidates.some((item) => ['channel-mix', 'broad-risk'].includes(item.id)));
  assert.equal(result.evidence.length, 1);
});

test('confirmed imports use the same calculations and document declaration versus verification', () => {
  for (const { id } of scenarios) {
    const result = imported({ rows: generateData(id), maturityConfirmed: true });
    const synthetic = run(id);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.metrics, synthetic.metrics);
    assert.deepEqual(result.decomposition, synthetic.decomposition);
    assert.equal(result.conclusion.id, synthetic.conclusion.id);
    assert.equal(result.quality.maturitySource, 'user_declaration');
    assert.ok(result.assumptions.some((text) => text.includes('不等于机器验证')));
    assert.equal(synthetic.datasetId, `synthetic:${id}:v1`);
  }
  assert.equal(imported({ maturityConfirmed: 'true' }).status, 'needs_review');
});

test('missing whole dates and missing single channel-days both block imported analysis', () => {
  for (const rows of [
    generateData().filter((row) => row.date !== '2026-06-02'),
    generateData().filter((row) => !(row.date === '2026-06-02' && row.channel === 'A')),
  ]) {
    const result = imported({ rows, maturityConfirmed: true });
    assert.equal(result.status, 'blocked');
    assert.equal(result.metrics, null);
    assert.equal(result.checksExecuted, 0);
    assert.ok(result.issues.some((item) => item.code === 'missing_channel_day'));
    assert.match(result.message, /2026-06-02/);
  }
});

test('every dataset channel must be represented in the selected windows, including zero rows', () => {
  const rows = [...generateData(), { date: '2026-07-30', channel: 'D', count: 10, overdue: 1 }];
  const result = imported({ rows, maturityConfirmed: true });
  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.every((item) => item.code === 'missing_channel_day'));
  assert.match(result.message, /D/);
});

test('explicit zero channel-day is valid if that day and channel windows have samples', () => {
  const rows = generateData();
  rows[0] = { ...rows[0], count: 0, overdue: 0 };
  const result = imported({ rows, maturityConfirmed: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.issues, []);
  assert.equal(result.daily.baseline[0].count, rows[1].count + rows[2].count);
});

test('a day with zero total samples blocks instead of reporting zero risk', () => {
  const rows = generateData().map((row) => row.date === '2026-06-02' ? { ...row, count: 0, overdue: 0 } : row);
  const result = imported({ rows, maturityConfirmed: true });
  assert.equal(result.status, 'blocked');
  assert.equal(result.metrics, null);
  assert.ok(result.issues.some((item) => item.code === 'empty_sample'));
  assert.match(result.message, /2026-06-02/);
  assert.equal(result.checksExecuted, 0);
});

test('new, exited and always-empty channels retain null rates and prevent false decomposition', () => {
  for (const [counts, expected] of [
    [[[200, 0], [100, 100]], 'new'],
    [[[100, 100], [200, 0]], 'exited'],
    [[[200, 0], [200, 0]], 'empty'],
  ]) {
    const result = imported({ rows: pairRows(counts), ...TWO_DAYS, maturityConfirmed: true });
    const channel = result.channels.find((item) => item.channel === 'B');
    assert.equal(result.status, 'needs_review');
    assert.equal(channel.availability, expected);
    assert.equal(channel.rateDeltaPp, null);
    assert.ok(channel.baseline.rate === null || channel.anomaly.rate === null);
    assert.equal(result.decomposition, null);
    assert.equal(result.checksExecuted, 0);
    assert.equal(result.conclusion.id, 'unresolved');
    assert.ok(result.quality.warnings.some((item) => item.code === 'channel_not_comparable'));
  }
});

test('single channel can show a rise without claiming cross-channel common factors', () => {
  const rows = [
    { date: '2026-01-01', channel: 'A', count: 100, overdue: 10 },
    { date: '2026-01-02', channel: 'A', count: 100, overdue: 30 },
  ];
  const result = imported({ rows, ...TWO_DAYS, maturityConfirmed: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.conclusion.id, 'unresolved');
  assert.ok(!result.candidates.some((item) => ['channel-mix', 'broad-risk'].includes(item.id)));
  assert.equal(result.checksExecuted, 2);
  assert.ok(result.quality.warnings.some((item) => item.code === 'single_channel'));
  assert.equal(result.decomposition.compositionPp, 0);
  assert.ok(Number.isFinite(result.decomposition.withinChannelPp));
  assert.match(result.evidence.find((item) => item.id === 'within-channel').detail, /不适用/);
});

test('small samples have a precise teaching-threshold warning even after maturity confirmation', () => {
  const result = imported({ rows: pairRows([[49, 50], [100, 100]]), ...TWO_DAYS, maturityConfirmed: true });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.conclusion.label, '样本量不足，暂不归因');
  assert.equal(result.checksExecuted, 0);
  assert.equal(result.decomposition, null);
  const warning = result.quality.warnings.find((item) => item.code === 'small_sample');
  assert.match(warning.message, /正常期 99 笔，异常期 200 笔/);
  assert.match(warning.message, /100 笔/);
  assert.ok(!result.candidates.some((item) => ['channel-mix', 'broad-risk', 'stable'].includes(item.id)));
  assert.equal(imported({ rows: pairRows([[50, 50], [50, 50]]), ...TWO_DAYS, maturityConfirmed: true }).status, 'ready');
});

test('daily series and window rates pool counts, preserve natural dates, and ignore row ordering', () => {
  const rows = [
    { date: '2026-01-01', channel: 'A', count: 90, overdue: 9 },
    { date: '2026-01-01', channel: 'B', count: 10, overdue: 9 },
    { date: '2026-01-02', channel: 'A', count: 900, overdue: 90 },
    { date: '2026-01-02', channel: 'B', count: 100, overdue: 90 },
    { date: '2026-01-03', channel: 'A', count: 100, overdue: 20 },
    { date: '2026-01-03', channel: 'B', count: 100, overdue: 20 },
  ];
  const args = { baseline: { start: '2026-01-01', end: '2026-01-02' }, anomaly: { start: '2026-01-03', end: '2026-01-03' }, maturityConfirmed: true };
  const result = imported({ rows, ...args });
  assert.deepEqual(result.daily.baseline, [
    { date: '2026-01-01', count: 100, overdue: 18, rate: 0.18 },
    { date: '2026-01-02', count: 1000, overdue: 180, rate: 0.18 },
  ]);
  assert.equal(result.metrics.baseline.rate, 198 / 1100);
  assert.equal(result.metrics.baseline.days, 2);
  assert.deepEqual(imported({ rows: [...rows].reverse(), ...args }), result);
});

test('analysis defensively validates rows independently of CSV parsing', async (t) => {
  const valid = pairRows();
  const cases = [
    ['non-array', null, 'invalid_rows'],
    ['empty', [], 'invalid_rows'],
    ['over limit', Array(20_001).fill(valid[0]), 'invalid_rows'],
    ['bad date', [{ ...valid[0], date: '2026-02-30' }, ...valid.slice(1)], 'invalid_row'],
    ['empty channel', [{ ...valid[0], channel: ' ' }, ...valid.slice(1)], 'invalid_row'],
    ['fractional count', [{ ...valid[0], count: 1.5 }, ...valid.slice(1)], 'invalid_row'],
    ['negative count', [{ ...valid[0], count: -1 }, ...valid.slice(1)], 'invalid_row'],
    ['infinite count', [{ ...valid[0], count: Infinity }, ...valid.slice(1)], 'invalid_row'],
    ['string count', [{ ...valid[0], count: '100' }, ...valid.slice(1)], 'invalid_row'],
    ['overdue beyond count', [{ ...valid[0], overdue: 101 }, ...valid.slice(1)], 'invalid_row'],
    ['duplicate aggregate', [...valid, valid[0]], 'duplicate_channel_day'],
    ['unsafe total', valid.map((row) => ({ ...row, count: Number.MAX_SAFE_INTEGER })), 'unsafe_total'],
    ['too many channels', Array.from({ length: 51 }, (_, index) => ({ ...valid[0], channel: `channel-${index}` })), 'dataset_limits'],
    ['too wide date range', [valid[0], { ...valid[2], date: '2027-01-02' }], 'dataset_limits'],
  ];
  for (const [label, rows, code] of cases) {
    await t.test(label, () => {
      const result = imported({ rows, ...TWO_DAYS, maturityConfirmed: true });
      assert.equal(result.status, 'blocked');
      assert.equal(result.checksExecuted, 0);
      assert.ok(result.issues.some((item) => item.code === code), JSON.stringify(result.issues));
    });
  }
});

test('missing dataset identity is rejected and input records remain unchanged', () => {
  assert.equal(imported({ datasetId: undefined }).issues[0].code, 'invalid_dataset_id');
  const rows = generateData();
  const copy = structuredClone(rows);
  imported({ rows, maturityConfirmed: true });
  assert.deepEqual(rows, copy);
});

test('unbounded requested dates block before expansion and out-of-range imports explain coverage', () => {
  const result = imported({
    baseline: { start: '0001-01-01', end: '2026-06-19' },
    anomaly: { start: '2026-07-20', end: '9999-12-31' },
    maturityConfirmed: true,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.checksExecuted, 0);
  assert.ok(result.issues.every((item) => item.code === 'missing_channel_day'));
  assert.match(result.message, /2026-06-01 至 2026-07-30/);
});

const boundaryRun = (before, after) => imported({
  ...TWO_DAYS,
  maturityConfirmed: true,
  rows: [before, after].flatMap((period, periodIndex) => period.map(([count, overdue], channelIndex) => ({
    date: periodIndex ? '2026-01-02' : '2026-01-01', channel: channelIndex ? 'B' : 'A', count, overdue,
  }))),
});
const ruleValue = (result, id, field) => result.evidence.find((item) => item.id === id).values[field];

test('exact 1pp overall boundary is an increase and cannot simultaneously count as stable', () => {
  const exact = boundaryRun([[100, 28], [100, 28]], [[100, 29], [100, 29]]);
  assert.ok(Math.abs(exact.metrics.deltaPp - 1) < 1e-10);
  assert.equal(exact.evidence.find((item) => item.id === 'overall-rate').kind, 'support');
  assert.equal(ruleValue(exact, 'stable-control', 'stable'), false);
  const below = boundaryRun([[10000, 2800], [10000, 2800]], [[10000, 2899], [10000, 2899]]);
  assert.equal(ruleValue(below, 'stable-control', 'stable'), true);
  assert.equal(below.evidence.find((item) => item.id === 'overall-rate').kind, 'context');
  const decrease = boundaryRun([[100, 29], [100, 29]], [[100, 28], [100, 28]]);
  assert.equal(ruleValue(decrease, 'stable-control', 'stable'), false);
});

test('exact 2pp channel increases match broad risk despite binary floating point rounding', () => {
  const exact = boundaryRun([[100, 28], [100, 28]], [[100, 30], [100, 30]]);
  assert.equal(exact.conclusion.id, 'broad-risk');
  assert.equal(ruleValue(exact, 'within-channel', 'broadShift'), true);
  assert.equal(ruleValue(exact, 'stable-control', 'stable'), false);
  const below = boundaryRun([[10000, 2800], [10000, 2800]], [[10000, 2999], [10000, 2999]]);
  assert.equal(ruleValue(below, 'within-channel', 'broadShift'), false);
});

test('stable channel bounds are strict at 2pp even when opposite movements cancel overall', () => {
  const exact = boundaryRun([[100, 28], [100, 28]], [[100, 30], [100, 26]]);
  assert.ok(Math.abs(exact.metrics.deltaPp) < 1e-10);
  assert.equal(ruleValue(exact, 'stable-control', 'stable'), false);
  const below = boundaryRun([[10000, 2800], [10000, 2800]], [[10000, 2999], [10000, 2601]]);
  assert.equal(ruleValue(below, 'stable-control', 'stable'), true);
});

test('exact 5pp mix share and 1pp composition boundaries activate structure rule together', () => {
  const exact = boundaryRun([[2400, 720], [7600, 760]], [[2900, 870], [7100, 710]]);
  assert.ok(Math.abs(exact.channels[0].shareDeltaPp - 5) < 1e-10);
  assert.ok(Math.abs(exact.decomposition.compositionPp - 1) < 1e-10);
  assert.equal(exact.conclusion.id, 'channel-mix');
});

test('exact 5pp share prevents stable classification while 4.99pp remains below the threshold', () => {
  const exact = boundaryRun([[2400, 240], [7600, 760]], [[2900, 290], [7100, 710]]);
  assert.ok(Math.abs(exact.metrics.deltaPp) < 1e-10);
  assert.equal(ruleValue(exact, 'stable-control', 'stable'), false);
  const below = boundaryRun([[240000, 24000], [760000, 76000]], [[289900, 28990], [710100, 71010]]);
  assert.equal(ruleValue(below, 'stable-control', 'stable'), true);
});

test('exact 2pp high-risk gap qualifies without binary arithmetic hiding a 1pp composition shift', () => {
  const exact = boundaryRun([[1000, 300], [9000, 2520]], [[6000, 1800], [4000, 1120]]);
  assert.ok(Math.abs(exact.metrics.deltaPp - 1) < 1e-10);
  assert.equal(exact.conclusion.id, 'channel-mix');
  assert.deepEqual(ruleValue(exact, 'channel-mix', 'matchedChannels'), ['A']);
  const below = boundaryRun([[100000, 29990], [900000, 252000]], [[600000, 179940], [400000, 112000]]);
  assert.deepEqual(ruleValue(below, 'channel-mix', 'matchedChannels'), []);
});
