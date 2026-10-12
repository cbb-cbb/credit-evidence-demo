import { analyze, scenarios, DEFAULT_PERIODS, DATA_COVERAGE, generateData } from './engine.mjs';

const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const percent = (value) => `${(value * 100).toFixed(2)}%`;
const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
const count = (value) => value.toLocaleString('zh-CN');
const decisionLabels = {confirmed:'支持当前解释',rejected:'不支持当前解释',uncertain:'仍不确定'};
const storageKey = 'credit-evidence-demo.reviews.v1';
let scenarioId = scenarios[0].id;
let current = null;
let dirty = false;
let reviews = [];
let storageAvailable = true;
let pendingExport = null;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
  if (Array.isArray(saved)) reviews = saved.filter((item) => item && typeof item.key === 'string' && typeof item.reason === 'string' && typeof item.createdAt === 'string' && decisionLabels[item.decision]);
} catch { storageAvailable = false; }

function readPeriods() {
  return {baseline:{start:$('base-start').value,end:$('base-end').value},anomaly:{start:$('anomaly-start').value,end:$('anomaly-end').value}};
}
function fillPeriods(periods = DEFAULT_PERIODS) {
  $('base-start').value = periods.baseline.start;
  $('base-end').value = periods.baseline.end;
  $('anomaly-start').value = periods.anomaly.start;
  $('anomaly-end').value = periods.anomaly.end;
}
function keyFor(result) { return JSON.stringify([result.scenarioId,result.periods]); }
function getReviews() { return current ? reviews.filter((entry) => entry.key === keyFor(current)) : []; }
function setDirty() {
  dirty = true;
  $('dirty-notice').hidden = false;
  $('export').disabled = true;
  $('review-section').hidden = true;
  const {baseline,anomaly} = readPeriods();
  const messages = [];
  if (baseline.start && baseline.end && baseline.start > baseline.end) messages.push('正常对比期：开始日期晚于结束日期，请调整任意一端。');
  if (anomaly.start && anomaly.end && anomaly.start > anomaly.end) messages.push('待分析期：开始日期晚于结束日期，请调整任意一端。');
  if (baseline.end && anomaly.start && baseline.end >= anomaly.start) messages.push('正常对比期需要早于待分析期，两期不能重叠。');
  $('date-hint').textContent = messages.join(' ');
  $('date-hint').hidden = !messages.length;
}
function renderScenarios() {
  $('scenarios').innerHTML = scenarios.map((scenario) => `<button type="button" class="scenario-button" data-scenario="${escape(scenario.id)}" aria-pressed="${scenario.id === scenarioId}"><span class="scenario-dot" aria-hidden="true"></span><span><strong>${escape(scenario.name)}</strong><small>${escape(scenario.description)}</small></span></button>`).join('');
}
function renderBlocked(result) {
  const missing = result.issues.some((issue) => ['missing_data','partial_coverage','empty_sample'].includes(issue.code));
  return `<div class="blocked" role="status"><span class="blocked-badge">${missing ? '数据覆盖检查未通过' : '请先调整输入'}</span><h3>${missing ? '这些日期没有完整数据，暂不归因。' : '时间窗口还需要调整。'}</h3><ul>${result.issues.map((issue) => `<li>${escape(issue.message)}</li>`).join('')}</ul><p>${missing ? '先调整到有数据的日期，或在实际业务中补齐数据。空记录不能当作零逾期率，历史相似案例也不能代替当前数据。' : '可以直接修改任意日期；四个日期都合法且两个窗口不重叠后再运行。'}</p><div class="blocked-stats"><span><strong>0</strong>项归因规则执行</span><span><strong>—</strong>本次归因结论</span></div><button class="secondary" data-action="restore" type="button">恢复有数据的日期并运行 →</button></div>`;
}
function renderReady(result) {
  const {baseline,anomaly,deltaPp} = result.metrics;
  const outcome = result.conclusion;
  const currentScenario = scenarios.find((scenario) => scenario.id === result.scenarioId);
  return `<div class="conclusion ${outcome.id === 'channel-mix' ? '' : 'neutral'}"><p class="result-kicker">数据覆盖完整 · 4项规则已检查</p><h3>${escape(outcome.label)}</h3><p>${escape(outcome.summary)}</p></div>
    <div class="result-meta"><span>当前数据：${escape(currentScenario.name)}</span><span>无模型调用 · 无正确率分数</span><span>正常：${escape(result.periods.baseline.start)} 至 ${escape(result.periods.baseline.end)}<br>待分析：${escape(result.periods.anomaly.start)} 至 ${escape(result.periods.anomaly.end)}</span></div>
    <div class="metric-grid"><div class="metric"><span>正常对比期逾期率</span><strong>${percent(baseline.rate)}</strong><small>${count(baseline.overdue)} / ${count(baseline.count)} 笔 · ${baseline.days}天</small></div><div class="metric"><span>待分析期逾期率</span><strong>${percent(anomaly.rate)}</strong><small>${count(anomaly.overdue)} / ${count(anomaly.count)} 笔 · ${anomaly.days}天</small></div><div class="metric delta"><span>两期变化</span><strong>${signed(deltaPp)}</strong><small>个百分点<br>按全部放款笔数加权</small></div></div>
    <h4 class="subheading">渠道对比 · 每个数字都来自当前数据</h4><div class="table-wrap"><table><caption class="sr-only">正常对比期与待分析期的渠道份额及逾期率</caption><thead><tr><th scope="col">渠道</th><th scope="col">占比：正常 → 待分析</th><th scope="col">逾期率：正常 → 待分析</th><th scope="col">占比变化</th></tr></thead><tbody>${result.channels.map((row) => `<tr class="${row.shareDeltaPp >= 5 ? 'highlight' : ''}"><td>渠道 ${escape(row.channel)}</td><td>${percent(row.baseline.share)} → ${percent(row.anomaly.share)}</td><td>${percent(row.baseline.rate)} → ${percent(row.anomaly.rate)}</td><td>${signed(row.shareDeltaPp)} pp</td></tr>`).join('')}</tbody></table></div><p class="table-note">pp = 百分点。统计为窗口内逾期笔数 ÷ 放款笔数；两期样本量不同，不能用放款总笔数直接比较增长。</p>
    <h4 class="subheading">证据与反证</h4><div class="evidence-grid">${result.evidence.map((evidence) => `<article class="evidence-item ${escape(evidence.kind)}"><span class="evidence-icon" aria-hidden="true">${evidence.kind === 'support' ? '✓' : evidence.kind === 'counter' ? '−' : '·'}</span><div><h4>${escape(evidence.label)}</h4><p>${escape(evidence.detail)}</p></div></article>`).join('')}</div>
    <details><summary>还有哪些解释，以及哪些信息缺失？</summary><div class="detail-content">${result.candidates.map((candidate) => `<p><strong>${escape(candidate.label)} · ${escape(candidate.assessment)}</strong><br>${escape(candidate.reason)}</p>`).join('')}</div></details>
    <details><summary>查看计算口径与数据</summary><div class="detail-content"><p>结构变化项 ${signed(result.decomposition.compositionPp)} pp + 渠道内部变化项 ${signed(result.decomposition.withinChannelPp)} pp ≈ 整体变化 ${signed(deltaPp)} pp。各项独立四舍五入，末位可能有差异。数学分解描述关联，不证明因果。</p><p>${result.assumptions.map(escape).join('<br>')}</p><p><a class="inline-link" href="./METHODS.md">查看生成参数与规则阈值 ↗</a></p><button class="secondary" type="button" data-action="csv">下载本场景合成数据 CSV ↓</button></div></details>`;
}
function renderReviews() {
  const records = getReviews();
  $('review-records').innerHTML = records.length ? `<h4 class="subheading">当前输入的复核记录 · ${records.length}</h4>${records.map((entry) => `<article class="review-entry"><strong>${escape(decisionLabels[entry.decision])}</strong><time datetime="${escape(entry.createdAt)}">${escape(new Date(entry.createdAt).toLocaleString('zh-CN'))}</time><p>${escape(entry.reason)}</p></article>`).join('')}` : '';
}
function run(reveal = false) {
  const previousKey = current ? keyFor(current) : null;
  current = analyze({scenarioId,...readPeriods()});
  dirty = false;
  $('dirty-notice').hidden = true;
  $('date-hint').hidden = true;
  $('result').innerHTML = current.status === 'blocked' ? renderBlocked(current) : renderReady(current);
  $('export').disabled = false;
  $('review-section').hidden = false;
  if (previousKey !== keyFor(current)) {
    $('review-reason').value = '';
    document.querySelector('input[name="decision"][value="uncertain"]').checked = true;
  }
  // A blocked result cannot support an attribution. Keep an explanatory review possible.
  for (const option of document.querySelectorAll('input[name="decision"]')) option.disabled = current.status === 'blocked' && option.value !== 'uncertain';
  if (current.status === 'blocked') document.querySelector('input[name="decision"][value="uncertain"]').checked = true;
  $('review-message').textContent = storageAvailable ? '' : '浏览器存储不可用；复核仅保留在本次页面，可导出保存。';
  renderReviews();
  if (reveal && matchMedia('(max-width:760px)').matches) {
    $('result').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});
  }
}
function download(filename,content,type) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url),1500);
}
function showExport(filename,content,type,title) {
  pendingExport = {filename,content,type};
  $('export-heading').textContent = title;
  $('export-content').value = content;
  $('export-message').textContent = filename;
  $('export-dialog').showModal();
}
$('close-export').addEventListener('click',() => $('export-dialog').close());
$('download-export').addEventListener('click',() => {
  if (!pendingExport) return;
  download(pendingExport.filename,pendingExport.content,pendingExport.type);
  $('export-message').textContent = '已请求下载；若浏览器没有保存文件，可复制上方内容。';
});
$('copy-export').addEventListener('click',async() => {
  if (!pendingExport) return;
  try {await navigator.clipboard.writeText(pendingExport.content);$('export-message').textContent='内容已复制。';}
  catch {$('export-content').focus();$('export-content').select();$('export-message').textContent='已选中内容，请按 Ctrl+C（Mac 使用 Command+C）复制。';}
});
$('scenarios').addEventListener('click',(event) => {
  const button = event.target.closest('[data-scenario]');
  if (!button) return;
  scenarioId = button.dataset.scenario;
  renderScenarios(); run(true);
});
$('analysis-form').addEventListener('submit',(event) => {event.preventDefault();run(true);});
for (const input of document.querySelectorAll('input[type="date"]')) input.addEventListener('input',setDirty);
$('missing-case').addEventListener('click',() => {
  fillPeriods({baseline:{start:'2026-09-01',end:'2026-09-15'},anomaly:{start:'2026-09-16',end:'2026-09-30'}});run(true);
});
$('reset-periods').addEventListener('click',() => {fillPeriods();run(true);});
$('result').addEventListener('click',(event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'restore') {fillPeriods();run(true);}
  if (action === 'csv' && current && !dirty) {
    const rows = generateData(current.scenarioId);
    const csv = ['date,channel,count,overdue',...rows.map((row) => [row.date,row.channel,row.count,row.overdue].join(','))].join('\r\n');
    showExport(`synthetic-${current.scenarioId}.csv`,csv,'text/csv;charset=utf-8','本场景合成数据 CSV');
  }
});
$('review-form').addEventListener('submit',(event) => {
  event.preventDefault();
  if (!current || dirty) return;
  const reason = $('review-reason').value.trim();
  if (!reason) {$('review-message').textContent='请填写具体理由，例如你依据哪条证据、还缺什么信息。';$('review-reason').focus();return;}
  const decision = document.querySelector('input[name="decision"]:checked').value;
  if (current.status === 'blocked' && decision !== 'uncertain') return;
  const entry = {id:crypto.randomUUID(),key:keyFor(current),decision,reason,createdAt:new Date().toISOString()};
  reviews.push(entry);
  try {localStorage.setItem(storageKey,JSON.stringify(reviews));storageAvailable=true;} catch {storageAvailable=false;}
  $('review-reason').value='';
  $('review-message').textContent=storageAvailable ? '复核已保存到当前浏览器。可导出记录或刷新验证。' : '已保存在本次页面，浏览器存储不可用；请导出记录。';
  renderReviews();
});
$('export').addEventListener('click',() => {
  if (!current || dirty) return;
  showExport(`credit-evidence-${current.scenarioId}-${current.status}.json`,JSON.stringify({title:'信贷指标异常 · 证据工作台',version:1,exportedAt:new Date().toISOString(),notice:'合成数据与透明规则演示，无在线大模型调用；结论不证明因果。',analysis:current,reviews:getReviews().map(({key,...entry}) => entry)},null,2),'application/json;charset=utf-8','分析记录已生成');
});
$('coverage-label').textContent = `${DATA_COVERAGE.start} — ${DATA_COVERAGE.end}`;
fillPeriods();renderScenarios();run();
