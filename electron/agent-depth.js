const MAX_DESCENDANT_DEPTH = 4;

function pruneDeepAgents(account) {
  const allowed = item => (item.path || [item.name]).length <= MAX_DESCENDANT_DEPTH;
  if (Array.isArray(account.subagentThresholds)) account.subagentThresholds = account.subagentThresholds.filter(allowed);
  if (Array.isArray(account.expandedAgentPaths)) account.expandedAgentPaths = account.expandedAgentPaths.filter(path => path.length < MAX_DESCENDANT_DEPTH);
  if (Array.isArray(account.agentSnapshot?.agents)) account.agentSnapshot.agents = account.agentSnapshot.agents.filter(allowed).map(item => {
    if (item.path?.length === MAX_DESCENDANT_DEPTH) { const { childCount, childError, ...rest } = item; return rest; }
    return item;
  });
  for (const point of account.agentTrend || []) if (Array.isArray(point.agents)) point.agents = point.agents.filter(allowed);
  const pruneKeys = (entries, encoded) => {
    for (const key of Object.keys(entries || {})) {
      try {
        const parsed = JSON.parse(encoded ? Buffer.from(key, 'base64url').toString() : key);
        const path = encoded ? parsed[0] : parsed;
        if (Array.isArray(path) && path.length > MAX_DESCENDANT_DEPTH) delete entries[key];
      } catch { /* Preserve unrelated legacy keys. */ }
    }
  };
  pruneKeys(account.alertCandidates, true);
  pruneKeys(account.alertHistory?.agents, true);
  pruneKeys(account.deltaHistory?.agents, false);
  for (const history of account.alertHistoryArchive || []) pruneKeys(history.agents, true);
  return account;
}

module.exports = { MAX_DESCENDANT_DEPTH, pruneDeepAgents };
