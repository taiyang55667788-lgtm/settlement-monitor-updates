const fs = require('node:fs');
const path = require('node:path');

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function makeAbsolute(value, baseUrl) {
  const cleaned = unquote(value.trim());
  if (/^https:\/\//i.test(cleaned)) return cleaned;
  return new URL(cleaned, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function prepareManifest(manifest, baseUrl) {
  if (!/^https:\/\//i.test(String(baseUrl || ''))) {
    throw new Error('R2_PUBLIC_BASE_URL must be an HTTPS URL');
  }

  return manifest.replace(
    /^(\s*-?\s*(?:url|path):\s*)(.+?)\s*$/gm,
    (_line, prefix, value) => `${prefix}${makeAbsolute(value, baseUrl)}`,
  );
}

if (require.main === module) {
  const manifestPath = process.argv[2] || path.join(__dirname, '..', 'dist', 'latest.yml');
  const baseUrl = process.env.R2_PUBLIC_BASE_URL;
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(manifestPath, prepareManifest(manifest, baseUrl));
  console.log(`Prepared Cloudflare update manifest: ${manifestPath}`);
}

module.exports = { prepareManifest };
