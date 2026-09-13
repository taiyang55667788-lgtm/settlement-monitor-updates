const LEGACY_UPDATE_FEED_URL = 'https://github.com/taiyang55667788-lgtm/settlement-monitor-updates/releases/latest/download';
const DEFAULT_UPDATE_FEED_URL = 'https://pub-649c460a80df4ab1a6c668e4e67e2b6d.r2.dev';

function trimTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function migrateUpdateFeedUrl(value) {
  const normalized = trimTrailingSlashes(value);
  if (!normalized || normalized === trimTrailingSlashes(LEGACY_UPDATE_FEED_URL)) {
    return DEFAULT_UPDATE_FEED_URL;
  }
  return normalized;
}

module.exports = {
  DEFAULT_UPDATE_FEED_URL,
  LEGACY_UPDATE_FEED_URL,
  migrateUpdateFeedUrl,
};
