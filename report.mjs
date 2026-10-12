/**
 * Build a human-readable report from analysis summaries, never raw CSV rows.
 * This is a deterministic formatter. It makes no network or model calls.
 */

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = (value) => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '—';
const percent = (value) => finite(value) ? `${(value * 100).toFixed(2)}%` : '—';
const points = (value) => finite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)} pp` : '—';
const array = (value) => Array.isArray(value) ? value : [];

// Encode syntax before it reaches a Markdown parser. Newlines and control
// characters cannot introduce headings, HTML, tables, images, links or fences.
// Numeric entities preserve the readable literal text in a rendered report.
function plain(value, fallback = '—') {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return fallback;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  if (!clean) return fallback;
  return clean
    .replace(/[&<>"'\\`*_{}\[\]()#!|~]/g, (character) => `&#${character.codePointAt(0)};`)
    .replace(/^(?:[-+=]|\d+[.)])/, (prefix) => [...prefix].map((character) => `&#${character.codePointAt(0)};`).join(''))
    .replace(/:(?=\/\/)/g, '&#58;')
    .replace(/\.(?=[a-zA-Z]{2,}(?:[\/\s:]|$))/g, '&#46;')
    .replace(/@/g, '&#64;');
}

const periodText = (period) => `${plain(period?.start)} 至 ${plain(period?.end)}`;
const warningText = (item) => `${plain(item?.message)}（代码：${plain(item?.code)}）`;
const decisions = { confirmed: '支持当前解释', rejected: '不支持当前解释', uncertain: '仍不确定' };
const availabilityLabels = { new: '新增渠道，正常期无样本', exited: '退出渠道，待分析期无样本', empty: '两期均无样本', comparable: '两期均有样本' };

function maturityStatement(result) {
  const quality = result.quality;
  if (quality?.maturitySource === 'synthetic_assumption' || (!quality && result.dataSource === 'synthetic')) {
    return '合成结果按已完成观察期的假设生成；这项假设不证明真实业务样本已成熟。';
  }
  if (quality?.maturityConfirmed === true) {
    return '使用者声明样本已完成相同观察期；程序无法通过当前聚合字段独立验证这项声明。';
  }
  return '样本成熟度尚未确认。需确认两期都完成相同观察期，不能把尚未观察到的逾期当作未逾期。';
}

function nextSteps(result, findings) {
  const codes = findings.map((item) => String(item?.code ?? ''));
  const has = (pattern) => codes.some((code) => pattern.test(code));
  const steps = [];
  if (has(/^(missing_data|partial_coverage|empty_sample|missing_channel_day)$/)) {
    steps.push('按上方缺失提示补齐对应日期和渠道的数据，或把窗口调整到完整覆盖的日期后重跑；空记录不代表零风险。');
  }
  if (has(/invalid_date|reversed_period|overlapping_or_reversed_periods/)) {
    steps.push('修正开始与结束日期，确保正常对比期完整早于待分析期且两期不重叠，再运行检查。');
  }
  const minimum = finite(result.quality?.minimumWindowCount) ? result.quality.minimumWindowCount : null;
  const smallSample = has(/small_sample|insufficient_sample|low_sample|sample_size/) || (minimum !== null && ['baseline', 'anomaly'].some((key) => finite(result.metrics?.[key]?.count) && result.metrics[key].count < minimum));
  if (smallSample) {
    steps.push(`当前样本量不足${minimum !== null ? `（演示门槛为每期至少 ${number(minimum)} 笔）` : ''}；扩大合理时间窗口或补充同口径样本后复算，暂不依据波动做归因。该门槛不等同于统计显著性检验。`);
  }
  if (result.quality?.maturityConfirmed === false || result.quality?.maturitySource === 'unverified' || has(/maturity|immature/)) {
    steps.push('核对两期样本成熟度、观察时长及分母定义；确认观察期一致后再分析，无法核实时保留“仍不确定”。');
  }
  const incomparableChannels = array(result.channels).some((channel) => ['new', 'exited', 'empty'].includes(channel.availability));
  if (has(/incomparable|non_comparable|definition|metric_scope|inconsistent|channel_set/) || incomparableChannels) {
    steps.push('核对指标口径和渠道是否可比；新增、退出或无样本渠道不能直接比较自身逾期率。不要把缺失率补成零；口径统一前不解释渠道分解。');
  }
  if (result.status === 'blocked' && !steps.length) steps.push('先处理本报告列出的输入或数据问题，检查通过后重新运行；本次不形成归因结论。');
  if (result.status === 'needs_review' && !steps.length) steps.push('先处理质检警告并补充可比性说明，复核通过后再讨论候选解释；本次不形成归因结论。');
  if (result.status === 'ready') {
    steps.push('逐条核对证据编号与业务事实，把候选解释记录为待核查线索；需要确认因果时补充策略、模型或客群变化记录。');
  }
  steps.push('记录复核结论、具体证据和未解决的问题，保存报告以便复算比较。');
  return steps;
}

/** Return a Chinese Markdown report. reviews must already match this dataset/window. */
export function buildReport(result, reviews = [], { generatedAt = new Date().toISOString() } = {}) {
  const data = result && typeof result === 'object' ? result : {};
  const status = ['ready', 'blocked', 'needs_review'].includes(data.status) ? data.status : 'blocked';
  const state = { ready: '计算完成，候选解释待人工核查', blocked: '检查未通过，本次暂不归因', needs_review: '需人工复核，暂不形成归因结论' }[status];
  const normalized = { ...data, status };
  const issues = array(data.issues);
  const warnings = array(data.quality?.warnings);
  const findings = [...issues, ...warnings];
  const evidence = array(data.evidence);
  const candidates = array(data.candidates);
  const evidenceIds = new Map(evidence.map((item, index) => [item?.id, `E${index + 1}`]));
  const lines = [
    '# 信贷指标异常分析报告', '',
    '本报告由程序按计算结果生成，是结构化报告，未调用 LLM。候选解释是规则线索，不是因果证明，也不提供正确概率。', '',
    '## 数据与分析范围', '',
    `- 生成时间：${plain(generatedAt)}`,
    `- 数据来源：${data.dataSource === 'synthetic' ? '合成数据' : data.dataSource === 'imported_csv' ? '使用者导入的聚合 CSV' : '未提供'}`,
    `- 数据集名称：${plain(data.datasetName ?? data.scenarioId, '未命名')}`,
    `- 数据指纹：${plain(data.datasetId, '旧版结果未提供；建议重新运行以记录数据指纹')}`,
    `- 数据可用日期：${periodText(data.coverage)}`,
    `- 正常对比期：${periodText(data.periods?.baseline)}`,
    `- 待分析期：${periodText(data.periods?.anomaly)}`,
    `- 当前状态：${state}`,
    `- 已执行规则检查：${number(data.checksExecuted)} 项`, '',
    '本报告仅包含汇总指标、检查结果和复核文字，不包含上传的 CSV 原始记录。数据指纹用于区分版本，不代表数据经过真实性认证。', '',
    '## 数据质检与观察期', '',
    `- 成熟度说明：${maturityStatement(data)}`,
  ];
  if (issues.length) lines.push(...issues.map((item) => `- 阻断问题：${warningText(item)}`));
  if (warnings.length) lines.push(...warnings.map((item) => `- 质检警告：${warningText(item)}`));
  if (!findings.length) lines.push(`- ${data.quality ? '未收到额外质检警告；这不等同于数据已被独立审计。' : '旧版结果未提供独立质检记录，请结合原始口径说明复核。'}`);
  lines.push('', '## 指标与渠道对比', '');
  if (status === 'blocked' || !data.metrics) {
    lines.push('本次未形成可用指标比较，逾期率和变化均不展示。没有数据不等于逾期率为零。');
  } else {
    if (status === 'needs_review') lines.push('以下为描述性计算，仅供复核；尚不满足归因条件。', '');
    lines.push('| 时间窗口 | 样本笔数（分母） | 逾期笔数（分子） | 汇总逾期率 | 有数据天数 |', '| --- | ---: | ---: | ---: | ---: |');
    for (const [key, label] of [['baseline', '正常对比期'], ['anomaly', '待分析期']]) {
      const metric = data.metrics[key];
      lines.push(`| ${label} | ${number(metric?.count)} | ${number(metric?.overdue)} | ${percent(metric?.rate)} | ${number(metric?.days)} |`);
    }
    lines.push('', `整体变化：${points(data.metrics.deltaPp)}。pp 表示百分点。`, '',
      '计算口径：汇总逾期率 = 窗口内逾期笔数之和 ÷ 样本笔数之和，按样本分母加权，不对每日或各渠道的逾期率做简单平均。两期天数与样本量不同，不能直接用样本总数比较增长。');
    if (array(data.channels).length) {
      lines.push('', '| 渠道 | 正常期笔数 | 待分析期笔数 | 正常期占比 | 待分析期占比 | 正常期逾期率 | 待分析期逾期率 | 占比变化 | 逾期率变化 | 可比性 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
      for (const channel of data.channels) {
        lines.push(`| ${plain(channel.channel)} | ${number(channel.baseline?.count)} | ${number(channel.anomaly?.count)} | ${percent(channel.baseline?.share)} | ${percent(channel.anomaly?.share)} | ${percent(channel.baseline?.rate)} | ${percent(channel.anomaly?.rate)} | ${points(channel.shareDeltaPp)} | ${points(channel.rateDeltaPp)} | ${availabilityLabels[channel.availability] ?? '未提供单独标记'} |`);
      }
      lines.push('', '“—”表示未提供或无法比较，不代表零。');
    }
    if (data.decomposition) {
      lines.push('', `变化分解：渠道结构项 ${points(data.decomposition.compositionPp)} + 渠道内部项 ${points(data.decomposition.withinChannelPp)} ≈ 总变化 ${points(data.decomposition.totalPp ?? data.metrics.deltaPp)}。各项独立四舍五入，末位可能有差异；这是数学分解，不证明因果。`);
    } else lines.push('', '本次未提供可用的渠道变化分解；缺失项不补成零。');
  }
  lines.push('', '## 候选解释与证据', '');
  if (status === 'blocked') {
    lines.push('输入或数据检查未通过，未生成归因结论。先修复阻断问题，再进行证据比较。');
  } else {
    if (status === 'needs_review') lines.push('以下说明只用于定位待复核内容，不代表已确认业务原因。', '');
    if (data.conclusion) lines.push(`**${plain(data.conclusion.label)}**`, '', plain(data.conclusion.summary), '');
    if (!evidence.length) lines.push('当前结果没有提供可引用的证据条目。', '');
    for (const [index, item] of evidence.entries()) {
      const kind = { support: '支持线索', counter: '反证或不支持', context: '背景信息' }[item.kind] ?? '待复核信息';
      lines.push(`- **E${index + 1} · ${plain(item.label)}**（${kind}；原编号：${plain(item.id)}）：${plain(item.detail)}`);
    }
    const explanations = candidates.length ? candidates : data.conclusion ? [{ ...data.conclusion, reason: data.conclusion.summary }] : [];
    for (const item of explanations) {
      const refs = array(item.evidenceIds);
      const found = refs.map((id) => evidenceIds.get(id)).filter(Boolean);
      const missing = refs.filter((id) => !evidenceIds.has(id));
      lines.push('', `- 候选：${plain(item.label)}${item.assessment ? `；判断：${plain(item.assessment)}` : ''}。${plain(item.reason ?? item.summary, '未提供进一步解释')}`,
        `  证据引用：${found.length ? [...new Set(found)].join('、') : '未提供可匹配的证据编号，需人工核对'}${missing.length ? `；未找到编号：${missing.map((id) => plain(id)).join('、')}` : ''}。`);
    }
  }
  lines.push('', '## 缺失信息与适用边界', '',
    '当前聚合字段不能独立核验逐笔观察期、模型预测分数、AUC/KS、审批阈值或策略变更；仅凭逾期率不能确认模型失效或审批放宽。');
  if (findings.length) lines.push('', ...findings.map((item) => `- 本次待解决：${warningText(item)}`));
  if (array(data.assumptions).length) lines.push('');
  for (const assumption of array(data.assumptions)) lines.push(`- 口径与假设：${plain(assumption)}`);
  lines.push('', '## 人工复核', '', '以下为当前数据版本与分析窗口的复核记录，由使用者填写；程序未验证复核者身份或意见正确性。', '');
  if (!array(reviews).length) lines.push('暂无复核记录。');
  for (const [index, review] of array(reviews).entries()) {
    lines.push(`- 复核 ${index + 1}：${decisions[review?.decision] ?? '未识别的复核选项'}；时间：${plain(review?.createdAt)}。`, `  理由：${plain(review?.reason, '未填写理由')}`);
  }
  lines.push('', '## 下一步', '', ...nextSteps(normalized, findings).map((step, index) => `${index + 1}. ${step}`), '');
  return lines.join('\n');
}
