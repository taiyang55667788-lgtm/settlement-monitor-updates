function normalizeNavigationUrl(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function isRedirectAbort(error) {
  return error?.code === 'ERR_ABORTED'
    || error?.errno === -3
    || /ERR_ABORTED|\(-3\)/i.test(error?.message || '');
}

module.exports = { normalizeNavigationUrl, isRedirectAbort };
