const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('Windows release filenames are ASCII-safe and distinct', () => {
  const installer = pkg.build.nsis.artifactName;
  const portable = pkg.build.portable.artifactName;
  assert.match(installer, /^[\x20-\x7E]+$/);
  assert.match(portable, /^[\x20-\x7E]+$/);
  assert.notEqual(installer, portable);
  assert.match(installer, /Setup/);
  assert.match(portable, /Portable/);
});
