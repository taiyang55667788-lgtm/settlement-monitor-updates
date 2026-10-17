const ORIGIN = 'https://settlement-monitor-pairing.taiyang55667788.workers.dev';
const ROUTES = new Set(['GET /relay/health', 'POST /v1/pairings', 'GET /v1/pairings/status',
  'DELETE /v1/pairings', 'GET /v1/commands/next', 'GET /v1/commands/pending', 'POST /v1/commands/ack', 'POST /v1/messages/test', 'POST /v1/messages']);
export default {
  async fetch(request, env, ctx, fetcher = fetch) {
    const path = new URL(request.url).pathname;
    if (ROUTES.has(`${request.method} ${path}`)) {
      const headers = new Headers();
      for (const name of ['authorization', 'content-type']) {
        if (request.headers.has(name)) headers.set(name, request.headers.get(name));
      }
      try {
        const forward = env.PAIRING ? env.PAIRING.fetch.bind(env.PAIRING) : fetcher;
        const upstream = await forward(ORIGIN + (path === '/relay/health' ? '/health' : path), {
          method: request.method, headers, redirect: 'manual',
          ...(request.method === 'POST' ? { body: request.body } : {}),
          signal: AbortSignal.timeout(15000)
        });
        if (upstream.status >= 300 && upstream.status < 400) throw new Error('Upstream redirect rejected');
        return new Response(upstream.body, { status: upstream.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json({ error: '中转上游暂不可用' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
      }
    }
    if (path.startsWith('/v1/') || path.startsWith('/relay/')) return new Response('Not found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    if (path === '/health') {
      return Response.json({ ok: true, testOnly: true, service: 'settlement-connectivity-test', time: new Date().toISOString() }, {
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      });
    }
    return env.ASSETS.fetch(request);
  }
};
