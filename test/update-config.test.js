const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { prepareManifest } = require('../scripts/prepare-update-manifest');
const {
  DEFAULT_UPDATE_FEED_URL,
  LEGACY_UPDATE_FEED_URL,
  migrateUpdateFeedUrl,
} = require('../electron/update-feed');

test('Windows release filenames are ASCII-safe and distinct', () => {
  const installer = pkg.build.nsis.artifactName;
  const portable = pkg.build.portable.artifactName;
  assert.match(installer, /^[\x20-\x7E]+$/);
  assert.match(portable, /^[\x20-\x7E]+$/);
  assert.notEqual(installer, portable);
  assert.match(installer, /Setup/);
  assert.match(portable, /Portable/);
});

test('defaults and migrates the updater from GitHub to Cloudflare R2', () => {
  assert.equal(pkg.build.publish[0].url, DEFAULT_UPDATE_FEED_URL);
  assert.equal(migrateUpdateFeedUrl(''), DEFAULT_UPDATE_FEED_URL);
  assert.equal(migrateUpdateFeedUrl(`${LEGACY_UPDATE_FEED_URL}/`), DEFAULT_UPDATE_FEED_URL);
  assert.equal(migrateUpdateFeedUrl('https://updates.example.test/custom/'), 'https://updates.example.test/custom');
});

test('release manifest uses absolute Cloudflare download URLs', () => {
  const result = prepareManifest([
    'version: 1.0.8',
    'files:',
    '  - url: Settlement-Monitor-Setup-1.0.8-x64.exe',
    'path: Settlement-Monitor-Setup-1.0.8-x64.exe',
  ].join('\n'), DEFAULT_UPDATE_FEED_URL);

  assert.match(result, new RegExp(`url: ${DEFAULT_UPDATE_FEED_URL}/Settlement-Monitor-Setup-1\\.0\\.8-x64\\.exe`));
  assert.match(result, new RegExp(`path: ${DEFAULT_UPDATE_FEED_URL}/Settlement-Monitor-Setup-1\\.0\\.8-x64\\.exe`));
});
