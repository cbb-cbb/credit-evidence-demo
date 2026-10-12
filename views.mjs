export const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
export const percent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
export const signed = (value) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}` : '—';
export const count = (value) => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';

function issueList(issues) { return `<ul>${issues.map((issue) => `<li>${issue.row ? `第${escape(issue.row)}行：` : ''}${escape(issue.message)}</li>`).join('')}</ul>`; }
export function renderImportFeedback(dataset) {
  const {summary,issues,warnings} = dataset;
  if (dataset.status !== 'valid') return `<div class="quality-failed"><strong>校验未通过 · ${dataset.issueCount ?? issues.length}项问题</strong><p>请修复后重新载入，当前内容不会用于分析。</p>${issueList(issues.slice(0,10))}${issues.length>10?'<p>其余问题修复后可继续检查。</p>':''}</div>`;
  return `<div class="quality-passed"><strong>结构校验通过</strong><p>${count(summary.rowCount)}行 · ${summary.channelCount}个渠道 · ${count(summary.totalCount)}笔放款</p><p>${escape(summary.dateStart)} 至 ${escape(summary.dateEnd)}</p>${warnings.length ? `<details><summary>${dataset.warningCount ?? warnings.length}项提示，分析前请核对</summary>${issueList(warnings.slice(0,10))}</details>` : '<p>文件结构完整；观察期与业务口径仍需单独核查。</p>'}</div>`;
}
function dailyChart(result) {
  const before = result.daily?.baseline || [];
  const after = result.daily?.anomaly || [];
  const all = [...before,...after];
  const valid = all.filter((row) => Number.isFinite(row.rate));
  if (!valid.length) return '';
  const minDate = Math.min(...all.map((row) => Date.parse(`${row.date}T00:00:00Z`)));
  const maxDate = Math.max(...all.map((row) => Date.parse(`${row.date}T00:00:00Z`)));
  const ceiling = Math.max(0.05,Math.max(...valid.map((row) => row.rate))*1.15);
  const x = (date) => 49+(Date.parse(`${date}T00:00:00Z`)-minDate)/Math.max(maxDate-minDate,86400000)*622;
  const y = (rate) => 150-rate/ceiling*124;
  const path = (rows) => {
    let open = false;
    return rows.map((row) => {if(!Number.isFinite(row.rate)){open=false;return '';}const command=open?'L':'M';open=true;return `${command}${x(row.date).toFixed(2)},${y(row.rate).toFixed(2)}`;}).join(' ');
  };
  const ticks=[0,ceiling/2,ceiling];
  return `<section class="trend-section" aria-labelledby="trend-heading"><h4 class="subheading" id="trend-heading">每日逾期率 · 看变化是否持续</h4><div class="chart-legend"><span class="before">正常对比期</span><span class="after">待分析期</span></div><svg class="trend-chart" viewBox="0 0 720 180" role="img" aria-label="每日逾期率折线，正常期灰色、待分析期蓝色。精确数据可在下方每日明细中查看。">${ticks.map((tick)=>`<line x1="49" x2="671" y1="${y(tick)}" y2="${y(tick)}" stroke="#e3e9ee"/><text x="40" y="${y(tick)+4}" text-anchor="end">${percent(tick)}</text>`).join('')}<path d="${path(before)}" stroke="#8a9ead"/><path d="${path(after)}" stroke="#215ee7"/>${[[before,'#8a9ead'],[after,'#215ee7']].map(([rows,color])=>{const points=rows.filter((row)=>Number.isFinite(row.rate));return points.length===1?`<circle cx="${x(points[0].date)}" cy="${y(points[0].rate)}" r="3" fill="${color}"/>`:'';}).join('')}<text x="49" y="173">${escape(all[0].date)}</text><text x="671" y="173" text-anchor="end">${escape(all.at(-1).date)}</text></svg><details><summary>查看每日样本与指标明细（${all.length}天）</summary><div class="table-wrap daily-table"><table><thead><tr><th>时期</th><th>日期</th><th>放款笔数</th><th>逾期笔数</th><th>逾期率</th></tr></thead><tbody>${[['正常',before],['待分析',after]].flatMap(([label,rows])=>rows.map((row)=>`<tr><td>${label}</td><td>${escape(row.date)}</td><td>${count(row.count)}</td><td>${count(row.overdue)}</td><td>${percent(row.rate)}</td></tr>`)).join('')}</tbody></table></div></details></section>`;
}
function qualityWarnings(result) {
  const warnings = result.quality?.warnings || [];
  const maturity = result.dataSource === 'imported_csv'
    ? (result.quality?.maturityConfirmed ? '观察期与口径：使用者已声明确认，程序未独立验证。' : '观察期与口径：尚未确认，当前只能查看统计事实。')
    : '合成样本假设观察期完整；此假设不能代替实际业务核查。';
  return `<div class="quality-summary"><strong>分析前的数据检查</strong><p>${escape(maturity)}</p>${warnings.length ? issueList(warnings) : '<p>两个窗口通过当前数据覆盖与样本量检查。</p>'}</div>`;
}
export function renderResult(result) {
  const snapshot = `<div class="result-meta"><span>数据：${escape(result.datasetName || result.scenarioId)}</span><span>程序计算 · 无在线模型调用</span><span>正常：${escape(result.periods.baseline?.start)} 至 ${escape(result.periods.baseline?.end)}<br>待分析：${escape(result.periods.anomaly?.start)} 至 ${escape(result.periods.anomaly?.end)}</span></div>`;
  if (result.status === 'blocked') {
    const dates = result.issues.some((issue) => ['invalid_date','reversed_period','overlapping_or_reversed_periods'].includes(issue.code));
    const heading = dates ? '时间窗口还需要调整。' : '数据检查未通过，暂不归因。';
    return `${snapshot}<div class="blocked" role="status"><span class="blocked-badge">分析前检查已拦截</span><h3>${heading}</h3>${issueList(result.issues)}<p>缺记录不能当作零逾期率；请根据具体提示调整窗口或修复数据。</p><div class="blocked-stats"><span><strong>0</strong>项归因规则执行</span><span><strong>—</strong>本次归因结论</span></div><button class="secondary" data-action="restore" type="button">使用当前数据的建议日期 →</button></div>`;
  }
  const {baseline,anomaly,deltaPp} = result.metrics;
  const outcome = result.conclusion;
  const reviewNeeded = result.status === 'needs_review';
  const availability = {new:'本期新增',exited:'本期退出',empty:'两期无样本'};
  return `<div class="conclusion ${reviewNeeded?'needs-review':outcome.id==='channel-mix'?'':'neutral'}"><p class="result-kicker">${reviewNeeded ? '事实可查看 · 归因暂缓' : `检查完成 · ${result.checksExecuted}项规则已执行`}</p><h3>${escape(outcome.label)}</h3><p>${escape(outcome.summary)}</p></div>${snapshot}${qualityWarnings(result)}
    <div class="metric-grid"><div class="metric"><span>正常对比期逾期率</span><strong>${percent(baseline.rate)}</strong><small>${count(baseline.overdue)} / ${count(baseline.count)} 笔 · ${baseline.days}天</small></div><div class="metric"><span>待分析期逾期率</span><strong>${percent(anomaly.rate)}</strong><small>${count(anomaly.overdue)} / ${count(anomaly.count)} 笔 · ${anomaly.days}天</small></div><div class="metric delta"><span>两期变化</span><strong>${signed(deltaPp)}</strong><small>个百分点<br>按全部放款笔数加权</small></div></div>
    ${dailyChart(result)}
    <h4 class="subheading">渠道对比 · 当前窗口的实际统计</h4><div class="table-wrap"><table><caption class="sr-only">两期各渠道份额与逾期率</caption><thead><tr><th scope="col">渠道</th><th scope="col">占比：正常 → 待分析</th><th scope="col">逾期率：正常 → 待分析</th><th scope="col">占比变化</th></tr></thead><tbody>${result.channels.map((row)=>`<tr class="${row.shareDeltaPp>=5?'highlight':''}"><td>${escape(row.channel)}${availability[row.availability]?`<small class="channel-note">${availability[row.availability]}</small>`:''}</td><td>${percent(row.baseline.share)} → ${percent(row.anomaly.share)}</td><td>${percent(row.baseline.rate)} → ${percent(row.anomaly.rate)}</td><td>${signed(row.shareDeltaPp)} pp</td></tr>`).join('')}</tbody></table></div><p class="table-note">pp = 百分点；率为全部逾期笔数 ÷ 全部放款笔数。— 表示没有可计算的分母，不代表零风险。两期天数不同，不直接比较放款总量增幅。</p>
    <h4 class="subheading">${reviewNeeded?'统计事实与待核查项':'证据与反证'}</h4><div class="evidence-grid">${result.evidence.map((evidence,index)=>`<article class="evidence-item ${escape(evidence.kind)}"><span class="evidence-icon" aria-hidden="true">${index+1}</span><div><h4>E${index+1} · ${escape(evidence.label)}</h4><p>${escape(evidence.detail)}</p></div></article>`).join('')}</div>
    ${result.candidates.length?`<details><summary>还有哪些解释，以及哪些信息缺失？</summary><div class="detail-content">${result.candidates.map((candidate)=>`<p><strong>${escape(candidate.label)} · ${escape(candidate.assessment)}</strong><br>${escape(candidate.reason)}</p>`).join('')}</div></details>`:''}
    <details><summary>查看计算口径与当前数据</summary><div class="detail-content">${result.decomposition?`<p>结构变化 ${signed(result.decomposition.compositionPp)} pp + 渠道内部变化 ${signed(result.decomposition.withinChannelPp)} pp ≈ 整体变化 ${signed(deltaPp)} pp。各项独立四舍五入可能出现末位差异，数学分解不证明因果。</p>`:'<p>当前条件不适合渠道结构分解，未强行补零计算。</p>'}<p>${result.assumptions.map(escape).join('<br>')}</p><p><a class="inline-link" href="./METHODS.md">查看规则与阈值 ↗</a></p><button class="secondary" type="button" data-action="csv">导出当前数据 CSV ↓</button></div></details>`;
}
