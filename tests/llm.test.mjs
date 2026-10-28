import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, createAnalysis } from '../database.mjs';
import { DEFAULT_PERIODS } from '../engine.mjs';
import { modelConfig, evidencePacket, validateExplanation, explainAnalysis } from '../llm.mjs';

let db, record;
before(() => { db = openDatabase(':memory:'); record = createAnalysis(db, DEFAULT_PERIODS); });
after(() => db.close());
const config = modelConfig({ LLM_BASE_URL: 'https://model.example/v1', LLM_MODEL: 'test-model', LLM_API_KEY: 'test-secret-never-expose' });
const valid = () => ({ summary: '测试结构化响应，非真实模型效果。', observations: [{ text: '请复算 E1 的变化。', evidenceIds: ['E1'] }], hypotheses: [], nextSteps: ['核对业务记录'], limitations: ['合成数据'] });
const response = (value) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

test('model configuration requires complete settings and secure remote endpoints', () => {
  assert.equal(modelConfig({}).configured, false);
  assert.equal(modelConfig({ LLM_BASE_URL: 'https://model.example', LLM_MODEL: 'demo' }).configured, false);
  assert.equal(config.endpoint, 'https://model.example/v1/chat/completions');
  for (const base of ['http://remote.example', 'https://key:secret@model.example', 'https://model.example?secret=x', 'file:///tmp/model']) {
    assert.throws(() => modelConfig({ LLM_BASE_URL: base }), /HTTPS/);
  }
  assert.equal(modelConfig({ LLM_BASE_URL: 'http://127.0.0.1:8080/v1' }).endpoint, 'http://127.0.0.1:8080/v1/chat/completions');
});

test('missing configuration and failed data checks never call a model', async () => {
  const neverFetch = () => { assert.fail('model must not be called'); };
  await assert.rejects(explainAnalysis(record, modelConfig({}), neverFetch), { status: 503 });
  const blocked = createAnalysis(db, { ...DEFAULT_PERIODS, asOf: '2026-08-01' });
  await assert.rejects(explainAnalysis(blocked, config, neverFetch), { status: 422 });
});

test('model request sends aggregate evidence without loan records, credentials in content or redirects', async () => {
  let sent;
  const result = await explainAnalysis(record, config, async (url, options) => {
    assert.equal(url, config.endpoint);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
    sent = JSON.parse(options.body);
    return response(valid());
  });
  const packet = JSON.parse(sent.messages[1].content);
  assert.equal(packet.synthetic, true);
  assert.equal(packet.evidence[0].id, 'E1');
  assert.equal(sent.response_format.type, 'json_object');
  assert.doesNotMatch(sent.messages[1].content, /loan_id|SIM-\d|first_paid_date|test-secret-never-expose/);
  assert.equal(result.source, 'live_model');
  assert.equal(result.model, config.model);
});

test('unknown evidence citations, malformed JSON and incomplete explanations are rejected', () => {
  const packet = evidencePacket(record);
  assert.deepEqual(validateExplanation(JSON.stringify(valid()), packet), valid());
  const invalid = [null, {}, { ...valid(), observations: [] }, { ...valid(), summary: 'x'.repeat(1001) },
    { ...valid(), observations: [{ text: 'Invented', evidenceIds: ['E999'] }] }, { ...valid(), limitations: [] }];
  for (const value of invalid) assert.throws(() => validateExplanation(JSON.stringify(value), packet), { status: 502 });
  assert.throws(() => validateExplanation('```json\n{}\n```', packet), { status: 502 });
});

test('provider errors, timeout and oversized replies do not disclose secrets or provider bodies', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(explainAnalysis(record, config, async () => new Response('test-secret-never-expose provider details', { status })), (error) => {
      assert.equal(error.status, 502); assert.doesNotMatch(error.message, /test-secret|provider details/); return true;
    });
  }
  await assert.rejects(explainAnalysis(record, config, async () => { throw new Error('timeout test-secret-never-expose'); }), /请求失败或超时/);
  await assert.rejects(explainAnalysis(record, config, async () => new Response('x'.repeat(131073))), /请求失败或超时/);
});
