const test = require('node:test');
const assert = require('node:assert/strict');
const { trendDetails } = require('../ui/trend-details');
const now = Date.parse('2026-10-16T04:00:00Z');
const point = (minutes, value, path = ['parent', 'agent']) => ({ time: new Date(now - minutes * 60000).toISOString(), agents: value === null ? [] : [{ path, value }] });
test('trend windows are 30 minutes, one hour and 24 hours with exact path isolation', () => {
  const source = [point(1441, 1), point(1440, 2), point(61, 3), point(60, 4), point(31, 5), point(30, 6), point(0, -7), point(-1, 9), point(5, 999, ['other', 'agent'])];
  assert.deepEqual(trendDetails(source, ['parent', 'agent'], 30, now).points.map(p => p.value), [6, -7]);
  assert.equal(trendDetails(source, ['parent', 'agent'], 60, now).points.length, 4);
  assert.equal(trendDetails(source, ['parent', 'agent'], 1440, now).points.length, 6);
});
test('missing and widely separated samples break lines without inserting data', () => {
  const result = trendDetails([point(10, 100), point(9, null), point(8, -200), point(0, 0)], ['parent', 'agent'], 30, now);
  assert.equal(result.segments.length, 3); assert.equal(result.points.length, 3);
  assert.equal(result.low, -200); assert.equal(result.high, 100);
});
test('empty, flat, single, malformed and unordered samples remain safe', () => {
  assert.equal(trendDetails([], ['x'], 30, now).low, null);
  assert.equal(trendDetails([point(1, 0)], ['parent', 'agent'], 30, now).points.length, 1);
  const result = trendDetails([point(0, 5), point(2, 5), { time: 'invalid', agents: [] }, point(1, NaN)], ['parent', 'agent'], 30, now);
  assert.equal(result.low, 5); assert.equal(result.high, 5); assert.ok(result.points[0].time < result.points[1].time);
});
