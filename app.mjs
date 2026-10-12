import { analyze, analyzeRows, scenarios, DEFAULT_PERIODS, DATA_COVERAGE, generateData } from './engine.mjs';
import { parseDataset, toCsv, IMPORT_LIMITS } from './data-import.mjs';
import { buildReport } from './report.mjs';
import { escape, renderResult, renderImportFeedback } from './views.mjs';

const $ = (id) => document.getElementById(id);
const decisionLabels = {confirmed:'支持当前解释',rejected:'不支持当前解释',uncertain:'仍不确定'};
const storageKey = 'credit-evidence-demo.reviews.v1';
const runButton = document.querySelector('#analysis-form button[type="submit"]');
let sourceMode = 'demo', scenarioId = scenarios[0].id;
let importedDataset = null, inputName = '粘贴的 CSV', readVersion = 0;
let current = null, dirty = false, reviews = [], storageAvailable = true, pendingExport = null;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
  if (Array.isArray(saved)) reviews = saved.filter((item) => item && typeof item.key === 'string' && typeof item.reason === 'string' && typeof item.createdAt === 'string' && decisionLabels[item.decision]);
} catch { storageAvailable = false; }

function readPeriods() {
  return {baseline:{start:$('base-start').value,end:$('base-end').value},anomaly:{start:$('anomaly-start').value,end:$('anomaly-end').value}};
}
function suggestedPeriods() {
  if (sourceMode === 'demo') return DEFAULT_PERIODS;
  if (!importedDataset) return null;
  const {dateStart,dateEnd} = importedDataset.summary;
  const start = Date.parse(`${dateStart}T00:00:00Z`), end = Date.parse(`${dateEnd}T00:00:00Z`);
  const days = Math.round((end-start)/86400000)+1;
  if (days < 2) return null;
  const split = start + Math.floor(days/2)*86400000;
  return {baseline:{start:dateStart,end:new Date(split-86400000).toISOString().slice(0,10)},anomaly:{start:new Date(split).toISOString().slice(0,10),end:dateEnd}};
}
function fillPeriods(periods) {
  $('base-start').value = periods?.baseline.start || '';
  $('base-end').value = periods?.baseline.end || '';
  $('anomaly-start').value = periods?.anomaly.start || '';
  $('anomaly-end').value = periods?.anomaly.end || '';
}
function keyFor(result) { return JSON.stringify(['transparent-rules-v2',result.datasetId,result.periods,result.quality.maturityConfirmed]); }
function getReviews() { return current ? reviews.filter((entry) => entry.key === keyFor(current)) : []; }
function updateSource() {
  const imported = sourceMode === 'import';
  $('source-demo').setAttribute('aria-pressed',String(!imported));
  $('source-import').setAttribute('aria-pressed',String(imported));
  $('demo-source').hidden = imported;
  $('import-source').hidden = !imported;
  $('maturity-label').hidden = !imported;
  $('missing-case').hidden = imported;
  runButton.disabled = imported && !importedDataset;
  $('reset-periods').disabled = imported && !importedDataset;
  $('mode-badge').textContent = imported ? 'CSV 数据 · 当前浏览器内计算' : '合成数据 · 透明规则';
  $('coverage-label').textContent = imported ? (importedDataset ? `${importedDataset.summary.dateStart} — ${importedDataset.summary.dateEnd}` : '尚未载入有效数据') : `${DATA_COVERAGE.start} — ${DATA_COVERAGE.end}`;
  $('metric-label').textContent = imported ? '分析指标：overdue ÷ count（口径由使用者核对）' : '演示指标：首期30天逾期率（FPD30）';
  $('reset-periods').textContent = imported ? '使用当前数据的建议日期' : '恢复有数据的日期';
  $('source-note').textContent = imported ? '建议日期将覆盖范围分为前后两段，不代表业务基准。请按实际问题调整；缺失记录不会补零。' : '合成示例假设逾期观察期完整；此假设不能代替实际业务核查。';
}
function clearResult(message = '先载入有效 CSV，再选择时间窗口运行分析。') {
  current = null; dirty = false;
  $('result').innerHTML = `<div class="empty-state">${escape(message)}</div>`;
  $('dirty-notice').hidden = true;
  $('review-section').hidden = true;
  $('review-reason').value = '';
  $('review-records').innerHTML = '';
  $('export').disabled = true;
  $('report').disabled = true;
  $('date-hint').hidden = true;
}
function setDirty() {
  dirty = true;
  $('dirty-notice').hidden = !current;
  $('export').disabled = true;
  $('report').disabled = true;
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
function renderReviews() {
  const records = getReviews();
  $('review-records').innerHTML = records.length ? `<h4 class="subheading">当前数据与窗口的复核 · ${records.length}</h4>${records.map((entry) => `<article class="review-entry"><strong>${escape(decisionLabels[entry.decision])}</strong><time datetime="${escape(entry.createdAt)}">${escape(new Date(entry.createdAt).toLocaleString('zh-CN'))}</time><p>${escape(entry.reason)}</p></article>`).join('')}` : '';
}
function run(reveal = false) {
  if (sourceMode === 'import' && !importedDataset) return;
  const previousKey = current ? keyFor(current) : null;
  current = sourceMode === 'demo' ? analyze({scenarioId,...readPeriods()}) : analyzeRows({rows:importedDataset.rows,datasetId:importedDataset.fingerprint,datasetName:importedDataset.name,maturityConfirmed:$('maturity-confirmed').checked,...readPeriods()});
  dirty = false;
  $('dirty-notice').hidden = true;
  $('date-hint').hidden = true;
  $('result').innerHTML = renderResult(current);
  $('export').disabled = false;
  $('report').disabled = false;
  $('review-section').hidden = false;
  if (previousKey !== keyFor(current)) {
    $('review-reason').value = '';
    document.querySelector('input[name="decision"][value="uncertain"]').checked = true;
  }
  for (const option of document.querySelectorAll('input[name="decision"]')) option.disabled = current.status !== 'ready' && option.value !== 'uncertain';
  if (current.status !== 'ready') document.querySelector('input[name="decision"][value="uncertain"]').checked = true;
  $('review-message').textContent = storageAvailable ? '' : '浏览器存储不可用；复核仅保留在本次页面，可导出保存。';
  renderReviews();
  if (reveal && matchMedia('(max-width:760px)').matches) $('result').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});
}
function invalidateImport(message) {
  importedDataset = null;
  $('maturity-confirmed').checked = false;
  if (sourceMode === 'import') clearResult();
  $('import-feedback').textContent = message;
  updateSource();
}
function validateImport() {
  const dataset = parseDataset($('csv-text').value,{name:inputName});
  importedDataset = dataset.status === 'valid' ? dataset : null;
  $('maturity-confirmed').checked = false;
  clearResult(importedDataset ? '数据已载入。核对时间窗口和观察期后，点击“运行分析”。' : 'CSV 校验未通过，请根据数据校验提示修复。');
  $('import-feedback').innerHTML = renderImportFeedback(dataset);
  fillPeriods(suggestedPeriods());
  updateSource();
  if (importedDataset && !suggestedPeriods()) {
    $('date-hint').textContent = '至少需要两个不同日期，才能选择互不重叠的两个窗口。';
    $('date-hint').hidden = false;
  }
}
function switchSource(mode) {
  if (sourceMode === mode) return;
  readVersion += 1; sourceMode = mode;
  $('maturity-confirmed').checked = false;
  clearResult(importedDataset && mode === 'import' ? '已保留本次页面载入的数据，请核对窗口并重新分析。' : undefined);
  fillPeriods(suggestedPeriods()); updateSource();
  if (mode === 'demo') run();
}
function restorePeriods() {
  const periods = suggestedPeriods();
  if (!periods) return;
  fillPeriods(periods);
  if (sourceMode === 'import') $('maturity-confirmed').checked = false;
  run(true);
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
const exportName = () => `credit-evidence-${current.dataSource === 'synthetic' ? current.scenarioId : current.datasetId}-${current.status}`;
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
$('source-demo').addEventListener('click',()=>switchSource('demo'));
$('source-import').addEventListener('click',()=>switchSource('import'));
$('csv-text').addEventListener('input',()=>{
  readVersion += 1; inputName = '编辑的 CSV';
  $('csv-file').value = '';
  invalidateImport('内容已修改，请重新点击“校验并载入数据”。');
});
$('validate-csv').addEventListener('click',()=>{readVersion += 1;validateImport();});
$('csv-file').addEventListener('change',async()=>{
  const file = $('csv-file').files[0];
  if (!file) return;
  const version = ++readVersion;
  invalidateImport('正在读取本地文件…');
  $('csv-text').value = ''; inputName = file.name;
  if (file.size > IMPORT_LIMITS.bytes) {$('import-feedback').textContent='文件超过2MB，请拆分后重新选择。';return;}
  try {
    const text = await file.text();
    if (version !== readVersion) return;
    $('csv-text').value = text; validateImport();
  } catch {if (version === readVersion) $('import-feedback').textContent='无法读取文件，请重新选择 UTF-8 CSV，或粘贴内容。';}
});
$('load-sample').addEventListener('click',async()=>{
  const version = ++readVersion;
  $('load-sample').disabled = true;
  invalidateImport('正在载入站点附带的合成示例…');
  try {
    const response = await fetch('./examples/valid-channel.csv');
    if (!response.ok) throw new Error('sample unavailable');
    const text = await response.text();
    if (version !== readVersion) return;
    inputName = '合成示例 valid-channel.csv';
    $('csv-file').value = ''; $('csv-text').value = text; validateImport();
  } catch {if (version === readVersion) $('import-feedback').textContent='示例暂时无法载入，请重试或自行粘贴 CSV。';}
  finally {$('load-sample').disabled = false;}
});
$('scenarios').addEventListener('click',(event)=>{
  const button = event.target.closest('[data-scenario]');
  if (!button) return;
  scenarioId = button.dataset.scenario; renderScenarios(); run(true);
});
$('analysis-form').addEventListener('submit',(event)=>{event.preventDefault();run(true);});
for (const input of document.querySelectorAll('input[type="date"]')) input.addEventListener('input',()=>{
  if (sourceMode === 'import') $('maturity-confirmed').checked = false;
  setDirty();
});
$('maturity-confirmed').addEventListener('change',setDirty);
$('missing-case').addEventListener('click',()=>{
  fillPeriods({baseline:{start:'2026-09-01',end:'2026-09-15'},anomaly:{start:'2026-09-16',end:'2026-09-30'}});run(true);
});
$('reset-periods').addEventListener('click',restorePeriods);
$('result').addEventListener('click',(event)=>{
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'restore') restorePeriods();
  if (action === 'csv' && current && !dirty) {
    const rows = current.dataSource === 'synthetic' ? generateData(current.scenarioId) : importedDataset.rows;
    showExport(`${exportName()}.csv`,toCsv(rows),'text/csv;charset=utf-8','当前数据 CSV（包含所载入的全部日期）');
  }
});
$('review-form').addEventListener('submit',(event)=>{
  event.preventDefault();
  if (!current || dirty) return;
  const reason = $('review-reason').value.trim().slice(0,1200);
  if (!reason) {$('review-message').textContent='请填写具体理由，例如依据哪条证据、还缺什么信息。';$('review-reason').focus();return;}
  const decision = document.querySelector('input[name="decision"]:checked').value;
  if (current.status !== 'ready' && decision !== 'uncertain') return;
  reviews.push({id:crypto.randomUUID(),key:keyFor(current),datasetId:current.datasetId,decision,reason,createdAt:new Date().toISOString()});
  try {localStorage.setItem(storageKey,JSON.stringify(reviews));storageAvailable=true;} catch {storageAvailable=false;}
  $('review-reason').value='';
  $('review-message').textContent=storageAvailable?'复核已保存到当前浏览器，按数据内容、窗口和观察期声明隔离。':'已保存在本次页面，浏览器存储不可用；请导出记录。';
  renderReviews();
});
$('export').addEventListener('click',()=>{
  if (!current || dirty) return;
  showExport(`${exportName()}.json`,JSON.stringify({title:'信贷指标异常 · 证据工作台',version:2,exportedAt:new Date().toISOString(),notice:'浏览器端透明规则，无在线大模型调用；观察期声明未经程序核验，统计关联不证明因果。',analysis:current,reviews:getReviews().map(({key,...entry})=>entry)},null,2),'application/json;charset=utf-8','分析 JSON 记录');
});
$('report').addEventListener('click',()=>{
  if (!current || dirty) return;
  showExport(`${exportName()}.md`,buildReport(current,getReviews()),'text/markdown;charset=utf-8','分析报告 · Markdown');
});
fillPeriods(DEFAULT_PERIODS);renderScenarios();updateSource();run();
