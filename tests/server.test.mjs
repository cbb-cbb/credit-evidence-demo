import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { openDatabase } from '../database.mjs';
import { DEFAULT_PERIODS } from '../engine.mjs';
import { modelConfig } from '../llm.mjs';
import { createAppServer } from '../server.mjs';

let db, server, base, calls = 0, releaseModel = null;
const config = modelConfig({ LLM_API_KEY: 'private-test-key', LLM_MODEL: 'stub-model', LLM_BASE_URL: 'https://model.example/v1' });
before(async () => {
  db = openDatabase(':memory:');
  server = createAppServer({ db, config, fetchImpl: async () => {
    calls++;
    if (releaseModel) await releaseModel.promise;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '接口测试响应', observations: [{ text: '核对 E1', evidenceIds: ['E1'] }], hypotheses: [], nextSteps: ['核对'], limitations: ['仅测试'] }) } }] }));
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); db.close(); });
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const analyze = async () => { const response = await post('/api/analyses', DEFAULT_PERIODS); assert.equal(response.status, 201); return response.json(); };

test('status and static pages work without exposing credentials, database files or server sources', async () => {
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.database.synthetic, true); assert.ok(status.database.loanCount > 0);
  assert.equal(status.model.configured, true);
  assert.doesNotMatch(JSON.stringify(status), /private-test-key|apiKey|endpoint/);
  for (const path of ['/', '/assistant.html', '/assistant.mjs', '/assistant.css', '/DATABASE_LLM.md']) assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  for (const path of ['/.env', '/.env.example', '/.local/credit-demo.sqlite', '/server.mjs', '/database.mjs', '/%2e%2e/.env']) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
});

test('API supports analysis, saved explanation, history and manual review as one flow', async () => {
  const record = await analyze();
  assert.equal(record.result.status, 'ready'); assert.equal(record.explanation, null);
  const explanationPath = `/api/analyses/${record.id}/explanation`;
  const count = calls;
  const explanation = await (await post(explanationPath, {})).json();
  assert.equal(explanation.model, 'stub-model');
  assert.deepEqual(await (await post(explanationPath, {})).json(), explanation);
  assert.equal(calls, count + 1);
  assert.equal((await post(`/api/analyses/${record.id}/review`, { decision: 'uncertain', reason: 'E1 待核查' })).status, 200);
  const restored = await (await fetch(`${base}/api/analyses/${record.id}`)).json();
  assert.equal(restored.review.reason, 'E1 待核查'); assert.deepEqual(restored.explanation, explanation);
  assert.equal((await (await fetch(`${base}/api/analyses`)).json())[0].id, record.id);
});

test('simultaneous model clicks do not cause duplicate paid requests', async () => {
  const record = await analyze();
  let unblock, signal;
  releaseModel = { promise: new Promise((resolve) => { unblock = resolve; }) };
  const started = new Promise((resolve) => { signal = resolve; });
  const prior = releaseModel.promise;
  releaseModel.promise = { then: (...args) => { signal(); return prior.then(...args); } };
  const path = `/api/analyses/${record.id}/explanation`;
  const first = post(path, {});
  try {
    await started;
    assert.equal((await post(path, {})).status, 409);
  } finally { unblock(); releaseModel = null; }
  assert.equal((await first).status, 200);
});

test('invalid, oversized and cross-origin requests fail before changing data', async () => {
  const initial = await (await fetch(`${base}/api/analyses`)).json();
  for (const value of [null, [], 'not an object', { ...DEFAULT_PERIODS, scenarioId: 'unknown' }]) assert.equal((await post('/api/analyses', value)).status, 400);
  assert.equal((await post('/api/analyses', { payload: 'x'.repeat(20000) })).status, 413);
  assert.equal((await fetch(`${base}/api/analyses`, { method: 'POST', body: 'text' })).status, 415);
  assert.equal((await fetch(`${base}/api/analyses`, { method: 'POST', headers: { Origin: 'https://remote.example', 'Content-Type': 'application/json' }, body: JSON.stringify(DEFAULT_PERIODS) })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/status`, { headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost, 403);
  assert.deepEqual(await (await fetch(`${base}/api/analyses`)).json(), initial);
});
