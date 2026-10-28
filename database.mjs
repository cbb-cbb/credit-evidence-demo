import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { analyzeRows, generateData, scenarios, DATA_COVERAGE, DEFAULT_PERIODS } from './engine.mjs';

export const SNAPSHOT_DATE = '2026-10-01';
export const SEED_VERSION = 'synthetic-loans-v1';
const day = 86400000;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * day).toISOString().slice(0, 10);
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length) {
      if (!tables.some((table) => table.name === 'demo_metadata') ||
          db.prepare('SELECT value FROM demo_metadata WHERE key = ?').get('seed_version')?.value !== SEED_VERSION) {
        throw new Error('该文件不是本项目的模拟数据库，请使用新的 DATABASE_FILE 路径。');
      }
      return db;
    }
    db.exec(`BEGIN;
      CREATE TABLE demo_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE loans (
        dataset TEXT NOT NULL, loan_id TEXT NOT NULL, loan_date TEXT NOT NULL,
        channel TEXT NOT NULL, first_due_date TEXT NOT NULL, first_paid_date TEXT,
        PRIMARY KEY(dataset, loan_id)
      );
      CREATE INDEX loans_by_dataset_date ON loans(dataset, loan_date, channel);
      CREATE TABLE analyses (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, result_json TEXT NOT NULL,
        explanation_json TEXT, review_json TEXT
      );`);
    const insert = db.prepare('INSERT INTO loans VALUES (?, ?, ?, ?, ?, ?)');
    for (const scenario of scenarios) {
      let serial = 0;
      for (const row of generateData(scenario.id)) {
        const due = addDays(row.date, 30);
        for (let index = 0; index < row.count; index++) {
          // Synthetic schedules reconstruct the published aggregate scenarios.
          insert.run(scenario.id, `SIM-${++serial}`, row.date, row.channel, due,
            addDays(due, index < row.overdue ? 45 : 0));
        }
      }
    }
    db.prepare('INSERT INTO demo_metadata VALUES (?, ?)').run('seed_version', SEED_VERSION);
    db.exec('COMMIT;');
    return db;
  } catch (error) { db.close(); throw error; }
}

// Fixed parameterized query. No SQL from a user or model is executed.
// Numerator and denominator use the same matured first-instalment cohort.
export const AGGREGATE_SQL = `SELECT loan_date AS date, channel,
  SUM(CASE WHEN date(first_due_date, '+30 days') <= ? THEN 1 ELSE 0 END) AS count,
  SUM(CASE WHEN date(first_due_date, '+30 days') <= ?
    AND (first_paid_date IS NULL OR first_paid_date >= date(first_due_date, '+30 days'))
    THEN 1 ELSE 0 END) AS overdue
  FROM loans WHERE dataset = ? AND loan_date <= ?
  GROUP BY loan_date, channel ORDER BY loan_date, channel`;

export function databaseInfo(db) {
  return {
    kind: 'SQLite', synthetic: true, seedVersion: SEED_VERSION,
    loanCount: db.prepare('SELECT COUNT(*) AS count FROM loans').get().count,
    scenarios: scenarios.map(({ id, name }) => ({ id, name })),
    coverage: DATA_COVERAGE, defaultPeriods: DEFAULT_PERIODS, snapshotDate: SNAPSHOT_DATE,
    metricDefinition: '模拟首期应还日后第30天仍未还清的笔数 ÷ 已达到该观察日的贷款笔数。',
  };
}

export function queryAggregates(db, { scenarioId, asOf }) {
  if (!scenarios.some((scenario) => scenario.id === scenarioId)) throw new InputError('请选择已有的模拟数据集。');
  if (!validDate(asOf) || asOf > SNAPSHOT_DATE) throw new InputError(`数据截至日须为有效日期，且不晚于模拟快照 ${SNAPSHOT_DATE}。`);
  const rows = db.prepare(AGGREGATE_SQL).all(asOf, asOf, scenarioId, asOf).map((row) => ({ ...row }));
  const total = db.prepare('SELECT COUNT(*) AS count FROM loans WHERE dataset = ? AND loan_date <= ?').get(scenarioId, asOf).count;
  const matured = rows.reduce((sum, row) => sum + row.count, 0);
  return { rows, total, matured, excluded: total - matured };
}

export function createAnalysis(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('分析参数须为对象。');
  const { scenarioId = 'channel-mix', asOf = SNAPSHOT_DATE, baseline, anomaly } = input;
  for (const period of [baseline, anomaly]) {
    if (!period || !validDate(period.start) || !validDate(period.end)) throw new InputError('请填写两期有效的开始和结束日期。');
  }
  const aggregate = queryAggregates(db, { scenarioId, asOf });
  const datasetId = `sqlite-${createHash('sha256').update(JSON.stringify([SEED_VERSION, scenarioId, asOf, aggregate.rows])).digest('hex').slice(0, 24)}`;
  const result = analyzeRows({ rows: aggregate.rows, baseline, anomaly, datasetId,
    datasetName: `模拟数据库 · ${scenarios.find((item) => item.id === scenarioId).name}`, maturityConfirmed: true });
  result.dataSource = 'synthetic_database';
  result.scenarioId = scenarioId;
  result.quality.maturitySource = 'synthetic_schedule_check';
  result.assumptions = [
    '本次数据来自本地 SQLite 中的合成贷款记录，不包含真实客户或经营数据。',
    'SQL 按模拟首期应还日和数据截至日核验观察期，未成熟样本不进入分母。该口径需在接入真实业务时重新确认。',
    '统计规则提供排查线索，阈值尚未经过真实数据校准，数学贡献不等于业务因果。',
  ];
  result.database = { scenarioId, asOf, total: aggregate.total, matured: aggregate.matured,
    excluded: aggregate.excluded, seedVersion: SEED_VERSION,
    metricDefinition: databaseInfo(db).metricDefinition, queryId: 'mature-first-instalment-v1' };
  const record = { id: randomUUID(), createdAt: new Date().toISOString(), result, explanation: null, review: null };
  db.prepare('INSERT INTO analyses (id, created_at, result_json) VALUES (?, ?, ?)').run(record.id, record.createdAt, JSON.stringify(result));
  return record;
}

export function getAnalysis(db, id) {
  const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
  if (!row) throw new InputError('找不到这次分析，请重新运行。', 404);
  return { id: row.id, createdAt: row.created_at, result: JSON.parse(row.result_json),
    explanation: row.explanation_json ? JSON.parse(row.explanation_json) : null,
    review: row.review_json ? JSON.parse(row.review_json) : null };
}
export function listAnalyses(db) {
  return db.prepare('SELECT id, created_at, result_json FROM analyses ORDER BY rowid DESC LIMIT 12').all().map((row) => {
    const result = JSON.parse(row.result_json);
    return { id: row.id, createdAt: row.created_at, name: result.datasetName, status: result.status, periods: result.periods };
  });
}
export function saveExplanation(db, id, explanation) {
  getAnalysis(db, id);
  db.prepare('UPDATE analyses SET explanation_json = ? WHERE id = ?').run(JSON.stringify(explanation), id);
}
export function saveReview(db, id, input) {
  const record = getAnalysis(db, id);
  if (!['confirmed', 'rejected', 'uncertain'].includes(input?.decision) ||
      typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1200) {
    throw new InputError('请选择复核结论，并填写 1—1200 字的具体理由。');
  }
  if (record.result.status !== 'ready' && input.decision !== 'uncertain') throw new InputError('数据检查未通过时，只能保留“仍不确定”。');
  const review = { decision: input.decision, reason: input.reason.trim(), updatedAt: new Date().toISOString() };
  db.prepare('UPDATE analyses SET review_json = ? WHERE id = ?').run(JSON.stringify(review), id);
  return review;
}
