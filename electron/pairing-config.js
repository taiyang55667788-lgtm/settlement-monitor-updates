// Set this to the verified Cloudflare Worker URL before releasing pairing mode.
// Bot credentials live only in Worker secrets and must never be bundled here.
const PAIRING_SERVICE_URL = 'https://settlement-monitor-pairing.taiyang55667788.workers.dev';

module.exports = { PAIRING_SERVICE_URL };
