import { renderResult, escape } from './views.mjs';
import { buildReport } from './report.mjs';
const $ = (id) => document.getElementById(id);
let service = null, current = null, revision = 0, exported = null;
async function api(path, body, timeout = 12000) {
  const response = await fetch(path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('这里需要本地后台服务。请在项目目录运行 npm start，再打开 http://127.0.0.1:5174/assistant.html。');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求未完成，请稍后重试。');
  return data;
}
const message = (error) => error.name === 'TimeoutError' ? '请求超时，请检查本地服务或网络后重试。' : error.message || '连接失败，请检查本地服务。';
function periods() {
  return { baseline: { start: $('db-base-start').value, end: $('db-base-end').value }, anomaly: { start: $('db-anomaly-start').value, end: $('db-anomaly-end').value } };
}
function fillPeriods(value) {
  $('db-base-start').value = value.baseline.start; $('db-base-end').value = value.baseline.end;
  $('db-anomaly-start').value = value.anomaly.start; $('db-anomaly-end').value = value.anomaly.end;
}
function invalidate() {
  revision++; current = null;
  $('database-result').innerHTML = '<div class="empty-state">参数已修改，请重新查询数据库。</div>';
  $('snapshot-info').textContent = ''; $('model-result').replaceChildren();
  $('explain-message').textContent = ''; $('query-message').textContent = '';
  $('db-review-section').hidden = true;
  $('db-report').disabled = true; $('db-export').disabled = true; $('explain-button').disabled = true;
}
function renderModel() {
  const explanation = current?.explanation;
  $('model-result').replaceChildren();
  $('model-setup').hidden = Boolean(service?.model.configured);
  $('explain-button').disabled = !current || current.result.status !== 'ready' || !service?.model.configured || Boolean(explanation);
  $('explain-button').textContent = explanation ? '本次大模型解读已保存' : '生成大模型解读';
  $('llm-note').textContent = !service?.model.configured ? '大模型尚未配置；数据库统计与复核已经可以使用。' :
    `点击后向已配置的 ${service.model.name} 接口发送本次合成汇总证据，可能消耗 API 额度。模型不接收贷款明细。`;
  if (!explanation) return;
  const claims = (items) => items.map((item) => `<li>${escape(item.text)} ${item.evidenceIds.map((id) => `<a class="evidence-ref" href="#evidence-${escape(id)}">${escape(id)}</a>`).join('')}</li>`).join('');
  $('model-result').innerHTML = `<div class="model-summary">${escape(explanation.summary)}</div><div class="model-detail"><h4>观察事实</h4><ul>${claims(explanation.observations)}</ul><h4>待核查解释</h4>${explanation.hypotheses.length ? `<ul>${claims(explanation.hypotheses)}</ul>` : '<p class="field-help">模型未提出额外解释。</p>'}<h4>建议下一步</h4><ul>${explanation.nextSteps.map((item) => `<li>${escape(item)}</li>`).join('')}</ul><h4>仍然存在的限制</h4><ul>${explanation.limitations.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></div><p class="model-metadata">模型：${escape(explanation.model)} · ${escape(new Date(explanation.generatedAt).toLocaleString('zh-CN'))}<br>${escape(explanation.notice)}</p>`;
}
function renderRecord() {
  const { result, review } = current;
  $('database-result').innerHTML = renderResult(result);
  $('database-result').querySelector('[data-action="csv"]')?.remove();
  $('database-result').querySelectorAll('.evidence-item').forEach((item, index) => { item.id = `evidence-E${index + 1}`; });
  const { asOf, total, matured, excluded } = result.database;
  $('snapshot-info').textContent = `模拟快照截至 ${asOf}：当前场景共 ${total.toLocaleString()} 笔，成熟 ${matured.toLocaleString()} 笔，排除未成熟 ${excluded.toLocaleString()} 笔。下方指标只统计所选两个窗口。`;
  $('db-report').disabled = false; $('db-export').disabled = false;
  $('db-review-section').hidden = false;
  $('db-decision').value = review?.decision || 'uncertain'; $('db-reason').value = review?.reason || '';
  for (const option of $('db-decision').options) option.disabled = result.status !== 'ready' && option.value !== 'uncertain';
  $('db-review-message').textContent = review ? `已保存：${new Date(review.updatedAt).toLocaleString('zh-CN')}` : '';
  $('explain-message').textContent = result.status !== 'ready' ? '数据检查未通过，先处理观察期、日期覆盖或样本问题。' : '';
  renderModel();
}
async function history() {
  const items = await api('/api/analyses');
  $('history').innerHTML = items.length ? items.map((item) => `<button class="history-item" type="button" data-record="${escape(item.id)}" aria-pressed="${item.id === current?.id}">${escape(item.name)}<small>${escape(item.periods.anomaly.start)}—${escape(item.periods.anomaly.end)}<br>${escape(new Date(item.createdAt).toLocaleString('zh-CN'))}</small></button>`).join('') : '<p class="field-help">完成第一次查询后，分析记录会保存在这里。</p>';
}
async function runAnalysis() {
  const ticket = ++revision;
  const input = { scenarioId: $('dataset').value, asOf: $('snapshot').value, ...periods() };
  current = null; $('query-fields').disabled = true;
  $('db-review-section').hidden = true; $('db-report').disabled = true; $('db-export').disabled = true; $('explain-button').disabled = true;
  $('model-result').replaceChildren(); $('snapshot-info').textContent = ''; $('explain-message').textContent = '';
  $('database-result').innerHTML = '<div class="empty-state">正在从数据库查询并计算…</div>';
  $('query-message').textContent = '正在查询数据库…';
  try {
    const record = await api('/api/analyses', input);
    if (ticket !== revision) return;
    current = record; renderRecord(); $('query-message').textContent = '查询完成，分析快照已保存。';
    await history();
  } catch (error) { if (ticket === revision) { $('query-message').textContent = message(error); $('database-result').innerHTML = '<div class="empty-state">查询未完成，请检查提示后重试。</div>'; } }
  finally { $('query-fields').disabled = !service; }
}
$('database-form').addEventListener('submit', (event) => { event.preventDefault(); runAnalysis(); });
$('query-fields').addEventListener('input', invalidate);
function restore() { if (!service) return; fillPeriods(service.database.defaultPeriods); $('snapshot').value = service.database.snapshotDate; invalidate(); }
$('restore-dates').addEventListener('click', restore);
$('database-result').addEventListener('click', (event) => { if (event.target.closest('[data-action="restore"]')) { restore(); runAnalysis(); } });
$('refresh-history').addEventListener('click', () => history().catch((error) => { $('query-message').textContent = message(error); }));
$('history').addEventListener('click', async (event) => {
  const id = event.target.closest('[data-record]')?.dataset.record;
  if (!id) return;
  invalidate(); const ticket = revision;
  try {
    const record = await api(`/api/analyses/${id}`);
    if (ticket !== revision) return;
    current = record; fillPeriods(record.result.periods);
    $('dataset').value = record.result.database.scenarioId; $('snapshot').value = record.result.database.asOf;
    renderRecord(); $('query-message').textContent = '已恢复历史分析快照。'; await history();
  } catch (error) { if (ticket === revision) $('query-message').textContent = message(error); }
});
$('explain-button').addEventListener('click', async () => {
  if (!current || !service?.model.configured || current.result.status !== 'ready') return;
  const id = current.id, ticket = revision;
  $('explain-button').disabled = true; $('explain-message').textContent = '正在调用配置的大模型，通常需要数秒…';
  try {
    const explanation = await api(`/api/analyses/${id}/explanation`, {}, 40000);
    if (current?.id !== id || revision !== ticket) return;
    current.explanation = explanation; $('explain-message').textContent = '解读已保存，请逐条核对证据与文字。';
    $('model-status').textContent = `本次模型调用成功 · ${explanation.model}`; renderModel();
  } catch (error) { if (current?.id === id && revision === ticket) { $('explain-message').textContent = message(error); renderModel(); } }
});
$('db-review-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!current) return;
  const id = current.id, ticket = revision;
  $('save-db-review').disabled = true;
  try {
    const review = await api(`/api/analyses/${id}/review`, { decision: $('db-decision').value, reason: $('db-reason').value });
    if (current?.id !== id || revision !== ticket) return;
    current.review = review; $('db-review-message').textContent = '复核已保存到本机数据库，刷新后仍可查看。';
  } catch (error) { if (current?.id === id) $('db-review-message').textContent = message(error); }
  finally { $('save-db-review').disabled = false; }
});
function showExport(format) {
  if (!current) return;
  const reviews = current.review ? [{ ...current.review, createdAt: current.review.updatedAt }] : [];
  exported = { name: `credit-db-${current.id}.${format}`, type: format === 'json' ? 'application/json' : 'text/markdown',
    content: format === 'json' ? JSON.stringify(current, null, 2) : buildReport(current.result, reviews, { explanation: current.explanation }) };
  $('db-export-content').value = exported.content; $('db-export-message').textContent = exported.name;
  $('db-export-heading').textContent = format === 'json' ? '完整分析记录 · JSON' : '分析报告 · Markdown'; $('db-export-dialog').showModal();
}
$('db-report').addEventListener('click', () => showExport('md'));
$('db-export').addEventListener('click', () => showExport('json'));
$('close-db-export').addEventListener('click', () => $('db-export-dialog').close());
$('copy-db-export').addEventListener('click', async () => {
  if (!exported) return;
  try { await navigator.clipboard.writeText(exported.content); $('db-export-message').textContent = '内容已复制。'; }
  catch { $('db-export-content').focus(); $('db-export-content').select(); $('db-export-message').textContent = '内容已选中，请按 Ctrl+C 复制。'; }
});
$('download-db-export').addEventListener('click', () => {
  if (!exported) return;
  const url = URL.createObjectURL(new Blob([exported.content], { type: `${exported.type};charset=utf-8` }));
  const link = document.createElement('a'); link.href = url; link.download = exported.name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
});
async function connect() {
  try {
    service = await api('/api/status');
    $('dataset').innerHTML = service.database.scenarios.map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
    fillPeriods(service.database.defaultPeriods); $('snapshot').value = service.database.snapshotDate; $('snapshot').max = service.database.snapshotDate;
    $('database-status').textContent = `数据库已连接 · ${service.database.loanCount.toLocaleString()} 笔合成贷款记录`;
    $('model-status').textContent = service.model.configured ? `模型已配置 · ${service.model.name}（待实际调用验证）` : '大模型未配置 · 数据库分析可用';
    $('query-fields').disabled = false; renderModel(); await history();
  } catch (error) {
    service = null; $('database-status').textContent = '本地数据库服务未连接'; $('model-status').textContent = '大模型状态未知';
    $('connection-error').hidden = false; $('connection-error').textContent = `${message(error)} 请在项目目录运行 npm start，并通过本机地址打开此页。GitHub Pages 只能展示静态页面，无法运行数据库后台。`;
    $('query-fields').disabled = true;
  }
}
connect();
