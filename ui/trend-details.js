(function (root) {
  function trendDetails(trend, path, minutes, now = Date.now(), gapMs = 300000) {
    const start = now - minutes * 60000;
    const key = JSON.stringify(path);
    const samples = (trend || []).map(point => ({ time: Date.parse(point.time), value: point.agents?.find(agent => JSON.stringify(agent.path) === key)?.value }))
      .filter(point => Number.isFinite(point.time) && point.time >= start && point.time <= now).sort((a, b) => a.time - b.time);
    const segments = []; let segment = [];
    for (const point of samples) {
      if (!Number.isFinite(point.value)) { if (segment.length) segments.push(segment); segment = []; continue; }
      if (segment.length && point.time - segment.at(-1).time > gapMs) { segments.push(segment); segment = []; }
      segment.push(point);
    }
    if (segment.length) segments.push(segment);
    const points = segments.flat();
    return { start, end: now, segments, points, low: points.length ? Math.min(...points.map(p => p.value)) : null, high: points.length ? Math.max(...points.map(p => p.value)) : null };
  }
  if (typeof module !== 'undefined') module.exports = { trendDetails };
  else root.trendDetails = trendDetails;
})(globalThis);
