import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateData, scenarios, DEFAULT_PERIODS } from '../engine.mjs';
import { openDatabase, databaseInfo, queryAggregates, createAnalysis, getAnalysis, listAnalyses, saveReview, SNAPSHOT_DATE } from '../database.mjs';
import { buildReport } from '../report.mjs';

let db;
before(() => { db = openDatabase(':memory:'); });
after(() => db.close());
const input = { scenarioId: 'channel-mix', asOf: SNAPSHOT_DATE, ...DEFAULT_PERIODS };

test('loan-level SQL reproduces all three aggregate scenarios exactly', () => {
  let total = 0;
  for (const { id } of scenarios) {
    const expected = generateData(id);
    const actual = queryAggregates(db, { scenarioId: id, asOf: SNAPSHOT_DATE });
    assert.deepEqual(actual.rows, expected);
    assert.equal(actual.excluded, 0);
    assert.equal(actual.total, expected.reduce((sum, row) => sum + row.count, 0));
    total += actual.total;
  }
  assert.equal(databaseInfo(db).loanCount, total);
});

test('observation day boundary excludes immature loans and classifies repayment timing consistently', () => {
  db.exec('SAVEPOINT boundary');
  try {
    db.prepare('DELETE FROM loans WHERE dataset = ?').run('stable');
    const insert = db.prepare('INSERT INTO loans VALUES (?, ?, ?, ?, ?, ?)');
    for (const [id, paid] of [['early', '2026-08-29'], ['boundary', '2026-08-30'], ['late', '2026-09-02'], ['unpaid', null]]) {
      insert.run('stable', id, '2026-07-01', 'A', '2026-07-31', paid);
    }
    const query = (asOf) => queryAggregates(db, { scenarioId: 'stable', asOf });
    assert.equal(query('2026-08-29').matured, 0);
    assert.equal(query('2026-08-29').excluded, 4);
    assert.deepEqual(query('2026-08-30').rows, [{ date: '2026-07-01', channel: 'A', count: 4, overdue: 3 }]);
    assert.deepEqual(query(SNAPSHOT_DATE).rows, query('2026-08-30').rows);
  } finally { db.exec('ROLLBACK TO boundary; RELEASE boundary'); }
});

test('incomplete observation windows block attribution without replacing missing rates with zero', () => {
  const record = createAnalysis(db, { ...input, asOf: '2026-08-01' });
  assert.equal(record.result.status, 'blocked');
  assert.equal(record.result.checksExecuted, 0);
  assert.ok(record.result.database.excluded > 0);
  assert.ok(!record.result.metrics);
  assert.throws(() => saveReview(db, record.id, { decision: 'confirmed', reason: 'cannot confirm' }), /仍不确定/);
  assert.equal(saveReview(db, record.id, { decision: 'uncertain', reason: '等待完整观察期' }).decision, 'uncertain');
});

test('invalid input and injection-shaped identifiers cannot become SQL', () => {
  for (const asOf of ['2026-02-30', '2026-10-02', "2026-01-01'; DROP TABLE loans;--"]) {
    assert.throws(() => queryAggregates(db, { scenarioId: 'stable', asOf }), /截至日/);
  }
  assert.throws(() => createAnalysis(db, { ...input, scenarioId: "stable' OR 1=1--" }), /已有的模拟/);
  assert.throws(() => createAnalysis(db, { ...input, baseline: { start: '', end: '2026-07-01' } }), /有效/);
  assert.throws(() => getAnalysis(db, "' OR 1=1--"), /找不到/);
  assert.ok(databaseInfo(db).loanCount > 0);
});

test('analysis snapshots and reviews survive reopening the database without reseeding', () => {
  const folder = mkdtempSync(join(tmpdir(), 'credit-evidence-test-'));
  const filename = join(folder, 'test.sqlite');
  let persistent;
  try {
    persistent = openDatabase(filename);
    const count = databaseInfo(persistent).loanCount;
    const record = createAnalysis(persistent, input);
    saveReview(persistent, record.id, { decision: 'uncertain', reason: 'E2 需要核对投放记录' });
    persistent.close(); persistent = openDatabase(filename);
    const restored = getAnalysis(persistent, record.id);
    assert.deepEqual(restored.result, record.result);
    assert.equal(restored.review.reason, 'E2 需要核对投放记录');
    assert.equal(listAnalyses(persistent)[0].id, record.id);
    assert.equal(databaseInfo(persistent).loanCount, count);
  } finally { persistent?.close(); unlinkSync(filename); rmdirSync(folder); }
});

test('opening an unrelated existing database leaves its tables and records intact', () => {
  const folder = mkdtempSync(join(tmpdir(), 'credit-foreign-test-'));
  const filename = join(folder, 'existing.sqlite');
  let foreign = new DatabaseSync(filename);
  try {
    foreign.exec("CREATE TABLE important (value TEXT); INSERT INTO important VALUES ('keep');");
    foreign.close(); foreign = null;
    assert.throws(() => openDatabase(filename), /不是本项目/);
    foreign = new DatabaseSync(filename);
    assert.equal(foreign.prepare('SELECT value FROM important').get().value, 'keep');
    assert.equal(foreign.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 1);
  } finally { foreign?.close(); unlinkSync(filename); rmdirSync(folder); }
});

test('database reports distinguish schedule checks and model text from statistical evidence', () => {
  const { result } = createAnalysis(db, input);
  const explanation = { model: 'test-provider', generatedAt: '2026-10-26T00:00:00Z', summary: '<script>untrusted</script>', observations: [{ text: '观察事实', evidenceIds: ['E1'] }], hypotheses: [], nextSteps: ['核查'], limitations: ['合成数据'], notice: '待人工复核' };
  const without = buildReport(result);
  assert.match(without, /SQLite 模拟贷款数据库/);
  assert.match(without, /按模拟贷款的首期应还日与数据截至日检查观察期/);
  assert.doesNotMatch(without, /使用者声明样本/);
  const withModel = buildReport(result, [], { explanation });
  assert.match(withModel, /另附大模型解读/);
  assert.match(withModel, /test-provider/);
  assert.match(withModel, /证据：E1/);
  assert.doesNotMatch(withModel, /未调用 LLM|<script>/);
});
