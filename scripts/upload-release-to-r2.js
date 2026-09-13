const fs = require('node:fs');
const path = require('node:path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const requiredEnvironment = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const distDir = path.join(__dirname, '..', 'dist');
const files = fs.readdirSync(distDir).filter((name) => (
  name === 'latest.yml' || name.endsWith('.exe') || name.endsWith('.blockmap')
));

if (!files.includes('latest.yml') || !files.some((name) => /Setup-.*\.exe$/i.test(name))) {
  throw new Error('Release output is missing latest.yml or the Windows installer');
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function upload(name) {
  const filePath = path.join(distDir, name);
  const isManifest = name === 'latest.yml';
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: name,
    Body: fs.createReadStream(filePath),
    ContentLength: fs.statSync(filePath).size,
    ContentType: isManifest ? 'application/yaml' : 'application/octet-stream',
    CacheControl: isManifest ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...(name.endsWith('.exe') ? { ContentDisposition: `attachment; filename=${name}` } : {}),
  }));
  console.log(`Uploaded ${name}`);
}

async function main() {
  const artifacts = files.filter((name) => name !== 'latest.yml');
  await Promise.all(artifacts.map(upload));
  await upload('latest.yml');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
