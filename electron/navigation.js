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

function isTransientScriptError(error) {
  return isRedirectAbort(error)
    || /Script failed to execute|Execution context was destroyed|detached frame|frame was detached/i.test(error?.message || '');
}

module.exports = { normalizeNavigationUrl, isRedirectAbort, isTransientScriptError };
