import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, DEFAULT_PERIODS } from '../engine.mjs';
import { buildReport } from '../report.mjs';

const generatedAt = '2026-10-12T10:00:00.000Z';
const report = (result, reviews = []) => buildReport(result, reviews, { generatedAt });
const ready = () => analyze({ scenarioId: 'channel-mix', ...DEFAULT_PERIODS });

test('report preserves denominator-weighted facts and referenceable evidence from the existing engine', () => {
  const result = ready();
  delete result.datasetId;
  delete result.quality;
  const output = report(result);
  assert.match(output, /未调用 LLM/);
  assert.match(output, /按样本分母加权，不对每日或各渠道的逾期率做简单平均/);
  assert.ok(output.includes(result.metrics.baseline.count.toLocaleString('zh-CN')));
  assert.ok(output.includes(result.metrics.baseline.overdue.toLocaleString('zh-CN')));
  assert.ok(output.includes(`${(result.metrics.baseline.overdue / result.metrics.baseline.count * 100).toFixed(2)}%`));
  assert.match(output, /E1 · 整体逾期率变化/);
  assert.match(output, /证据引用：E1、E2/);
  assert.match(output, /旧版结果未提供/);
  assert.match(output, /不证明因果/);
});

test('blocked result never exports fake zero metrics or a stale conclusion', () => {
  const result = analyze({ scenarioId: 'channel-mix', baseline: { start: '2026-09-01', end: '2026-09-15' }, anomaly: { start: '2026-09-16', end: '2026-09-30' } });
  result.metrics = ready().metrics; // A formatter must not leak a stale success payload.
  result.conclusion = { label: 'STALE-CONCLUSION', summary: 'STALE-SUMMARY' };
  const output = report(result);
  assert.match(output, /检查未通过，本次暂不归因/);
  assert.match(output, /没有数据不等于逾期率为零/);
  assert.match(output, /补齐对应日期和渠道的数据/);
  assert.doesNotMatch(output, /STALE-|0\.00%|汇总逾期率 \|/);
});

test('needs_review separates descriptive statistics from attribution and directs small-sample follow-up', () => {
  const result = ready();
  result.status = 'needs_review';
  result.quality = { maturityConfirmed: true, maturitySource: 'user_declaration', minimumWindowCount: 100, warnings: [{ code: 'small_sample', message: '窗口样本不足。' }] };
  const output = report(result);
  assert.match(output, /需人工复核，暂不形成归因结论/);
  assert.match(output, /描述性计算，仅供复核/);
  assert.match(output, /扩大合理时间窗口或补充同口径样本/);
  assert.match(output, /使用者声明样本已完成相同观察期/);
  assert.doesNotMatch(output, /先调整开始与结束日期/);
});

test('unknown maturity and incomparable channels have different next steps', () => {
  const result = ready();
  result.status = 'needs_review';
  result.quality = { maturityConfirmed: false, maturitySource: 'unverified', warnings: [] };
  result.channels[0].availability = 'new';
  const output = report(result);
  assert.match(output, /样本成熟度尚未确认/);
  assert.match(output, /核对两期样本成熟度、观察时长及分母定义/);
  assert.match(output, /核对指标口径和渠道是否可比/);
  assert.doesNotMatch(output, /当前样本量不足/);
});

test('null channel rates and absent decomposition render as unavailable rather than zero', () => {
  const result = ready();
  result.channels = [{ channel: '新渠道', baseline: { count: 0, overdue: 0, share: 0, rate: null }, anomaly: { count: 10, overdue: 1, share: 1, rate: 0.1 }, shareDeltaPp: 100, rateDeltaPp: null, availability: 'new' }];
  result.decomposition = null;
  const output = report(result);
  assert.match(output, /\| 新渠道 \| 0 \| 10 \| 0\.00% \| 100\.00% \| — \| 10\.00% \| \+100\.00 pp \| — \| 新增渠道/);
  assert.match(output, /未提供可用的渠道变化分解/);
});

test('report renders hostile names, labels and reviews as text and omits raw data payloads', () => {
  const result = ready();
  const dangerous = '![track](https://evil.example/pixel)\n# Forged heading\n<script>alert(1)</script>|cell|`code`';
  result.datasetName = dangerous;
  result.datasetId = 'csv-123';
  result.dataSource = 'imported_csv';
  result.channels[0].channel = dangerous;
  result.evidence[0].label = dangerous;
  result.rows = [{ name: 'RAW-PERSON-DO-NOT-EXPORT' }];
  result.daily = { baseline: [{ secret: 'DAILY-PAYLOAD-DO-NOT-EXPORT' }] };
  const output = report(result, [{ createdAt: generatedAt, decision: 'uncertain', reason: dangerous }]);
  assert.match(output, /使用者导入的聚合 CSV/);
  assert.match(output, /&#33;&#91;track&#93;/);
  assert.match(output, /&#60;script&#62;/);
  assert.match(output, /&#124;cell&#124;/);
  assert.match(output, /&#35; Forged heading/);
  assert.doesNotMatch(output, /!\[track\]|<script>|https:\/\/evil|\n# Forged|RAW-PERSON|DAILY-PAYLOAD/);
});

test('reviews are included with the supplied decision, timestamp and reason, without inventing reviewer identity', () => {
  const output = report(ready(), [{ decision: 'uncertain', createdAt: '2026-10-12T10:12:00Z', reason: 'E2 支持渠道变化，仍需核对观察期。' }]);
  assert.match(output, /复核 1：仍不确定/);
  assert.match(output, /E2 支持渠道变化，仍需核对观察期。/);
  assert.match(output, /程序未验证复核者身份/);
  assert.doesNotMatch(output, /暂无复核记录/);
});

test('missing evidence references are called out instead of replaced with invented evidence', () => {
  const result = ready();
  result.candidates = [{ label: '待核查', reason: '仅有部分证据', evidenceIds: ['overall-rate', 'not-present'] }];
  const output = report(result);
  assert.match(output, /证据引用：E1；未找到编号：not-present/);
});
