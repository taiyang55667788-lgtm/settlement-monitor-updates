const fs = require('node:fs');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');
const manifestPath = path.join(distDir, 'latest.yml');

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Missing update manifest: ${manifestPath}`);
}

const manifest = fs.readFileSync(manifestPath, 'utf8');
const assetNames = [...manifest.matchAll(/^\s*-?\s*(?:url|path):\s*(.+?)\s*$/gm)]
  .map((match) => match[1].replace(/^['"]|['"]$/g, ''));

if (!assetNames.length) {
  throw new Error('latest.yml does not contain an update asset name');
}

for (const assetName of new Set(assetNames)) {
  if (!/^[\x20-\x7E]+$/.test(assetName)) {
    throw new Error(`Update asset name must be ASCII-safe for GitHub Releases: ${assetName}`);
  }
  const localName = /^https:\/\//i.test(assetName) ? path.basename(new URL(assetName).pathname) : assetName;
  if (!fs.existsSync(path.join(distDir, localName))) {
    throw new Error(`latest.yml references a missing release asset: ${assetName}`);
  }
}

console.log(`Verified update manifest assets: ${[...new Set(assetNames)].join(', ')}`);
