import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, generateData, scenarios, DATA_COVERAGE, DEFAULT_PERIODS } from '../engine.mjs';

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
