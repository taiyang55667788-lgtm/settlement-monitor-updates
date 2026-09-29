const RECEIVABLE_DOWNLINE = 'receivable-downline';
const GENERAL_AGENT_RESULT = 'general-agent-result';
const AGENT_RESULT = 'agent-result';
const MEMBER_RESULT = 'member-result';

const METRICS = {
  [RECEIVABLE_DOWNLINE]: {
    id: RECEIVABLE_DOWNLINE,
    alertMetric: 'weekly-receivable-downline-v2',
    label: '应收下线',
    sectionLabel: '最多五级代理应收下线',
    valueLabel: '本周应收下线',
    reportOption: '',
    columnLabel: '应收下线',
    usesSubagents: true,
  },
  [GENERAL_AGENT_RESULT]: {
    id: GENERAL_AGENT_RESULT,
    alertMetric: 'weekly-crown-general-agent-details-v2',
    label: '总代理明细',
    sectionLabel: '本周总代理明细',
    valueLabel: '总代理结果',
    reportOption: '',
    columnLabel: '总代理结果',
    turnoverColumnLabel: '总代理实货量',
    usesSubagents: true,
    readsDescendants: false,
    agentLabel: '总代理',
    hasTurnover: true,
  },
  [AGENT_RESULT]: {
    id: AGENT_RESULT,
    alertMetric: 'weekly-agent-result-v2',
    label: '代理商结果',
    sectionLabel: '本周代理商交收',
    valueLabel: '本周代理商交收',
    reportOption: '代理商结果',
    columnLabel: '代理商结果',
    usesSubagents: false,
  },
  [MEMBER_RESULT]: {
    id: MEMBER_RESULT,
    alertMetric: 'weekly-member-result-v2',
    label: '会员结果',
    sectionLabel: '本周会员交收',
    valueLabel: '本周会员交收',
    reportOption: '会员结果',
    columnLabel: '会员结果',
    usesSubagents: false,
  },
};

function monitorMetric(value) {
  return METRICS[value] || METRICS[RECEIVABLE_DOWNLINE];
}

function monitorMetricId(value) {
  return monitorMetric(value).id;
}

module.exports = { RECEIVABLE_DOWNLINE, GENERAL_AGENT_RESULT, AGENT_RESULT, MEMBER_RESULT, monitorMetric, monitorMetricId };
