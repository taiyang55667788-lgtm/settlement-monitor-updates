(function (root) {
  const confirmedNoData = agent => agent.noData === true && !agent.stale && !agent.notRefreshed;
  function visibleParent(path, rows) {
    const parents = rows.map(row => row.subagent.path || [row.subagent.name]).filter(candidate => candidate.length < path.length && candidate.every((part, i) => path[i] === part));
    return parents.sort((a, b) => b.length - a.length)[0] || [];
  }
  const api = { confirmedNoData, visibleParent };
  if (typeof module !== 'undefined') module.exports = api;
  else root.agentVisibility = api;
})(globalThis);
