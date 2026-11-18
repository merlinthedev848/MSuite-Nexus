import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

export function createAdminRouter({ config, clients, github, metrics, events, assetCache = null, audit = null, log = console.log }) {
  const router = express.Router();
  router.use(express.json());

  const checkToken = (input) => {
    if (!input || typeof input !== 'string') return false;
    const expected = Buffer.from(config.adminToken, 'utf8');
    const actual = Buffer.from(input, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  };

  const extractAdminToken = (req) => {
    const auth = req.get('authorization');
    if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    if (req.get('x-admin-token')) return req.get('x-admin-token').trim();
    if (req.query.token) return String(req.query.token).trim();
    return null;
  };

  router.post('/login', (req, res) => {
    const { token } = req.body || {};
    if (!checkToken(token)) {
      audit?.record({ actor: 'unknown', ip: req.ip, action: 'LOGIN_FAILED', target: 'admin' });
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid admin token' });
    }
    audit?.record({ actor: 'admin', ip: req.ip, action: 'LOGIN_SUCCESS', target: 'admin' });
    res.json({ ok: true, message: 'Authenticated successfully' });
  });

  // Guard
  router.use((req, res, next) => {
    const token = extractAdminToken(req);
    if (!checkToken(token)) {
      return res.status(401).json({ error: 'unauthorized', message: 'Valid admin token required' });
    }
    next();
  });

  // Real-time SSE stream
  router.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    events.addClient(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

    const timer = setInterval(() => {
      try {
        if (!res.writableEnded && !res.destroyed) {
          res.write(': ping\n\n');
        } else {
          clearInterval(timer);
        }
      } catch {
        clearInterval(timer);
      }
    }, 15000);

    res.on('close', () => clearInterval(timer));
    res.on('error', () => clearInterval(timer));
  });

  // Overview metrics snapshot
  router.get('/overview', (req, res) => {
    const rateLimits = github.getRateLimits();
    const assetStats = assetCache?.getStats();
    const snapshot = metrics.getSnapshot(rateLimits, assetStats);

    res.json({
      ...snapshot,
      publicBaseUrl: config.publicBaseUrl,
      sseClients: events.connectedCount,
      adminTokenGenerated: Boolean(config.adminTokenGenerated),
      activeClientsCount: clients.byHash.size,
      totalClientsCount: clients.byName.size,
    });
  });

  // Audit Logs
  router.get('/audit', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json(audit ? audit.getEntries({ limit }) : []);
  });

  // Client management CRUD
  router.get('/clients', (req, res) => {
    const all = clients.getAllClients();
    const withUsage = all.map((c) => {
      const stats = metrics.clientStats.get(c.name) || { requests: 0, bytes: 0, lastSeen: null };
      return { ...c, ...stats };
    });
    res.json(withUsage);
  });

  router.post('/clients', (req, res) => {
    const { name, repos, permissions, description, allowedIps, expiresAt } = req.body || {};
    try {
      const result = clients.addClient({ name, repos, permissions, description, allowedIps, expiresAt });
      events.broadcast('client_change', { action: 'add', name: result.client.name });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'CLIENT_CREATED', target: result.client.name, details: { repos, permissions } });
      log(`Admin added client "${result.client.name}"`);
      res.status(201).json({
        ok: true,
        client: {
          name: result.client.name,
          repos: result.client.repos,
          permissions: Array.from(result.client.permissions),
          description: result.client.description,
          allowedIps: result.client.allowedIps,
          expiresAt: result.client.expiresAt,
        },
        key: result.key,
      });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  router.put('/clients/:name', (req, res) => {
    const { repos, permissions, disabled, description, allowedIps, expiresAt } = req.body || {};
    try {
      const updated = clients.updateClient(req.params.name, { repos, permissions, disabled, description, allowedIps, expiresAt });
      events.broadcast('client_change', { action: 'update', name: req.params.name });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'CLIENT_UPDATED', target: req.params.name, details: { disabled } });
      log(`Admin updated client "${req.params.name}"`);
      res.json({
        ok: true,
        client: {
          name: updated.name,
          repos: updated.repos,
          permissions: Array.from(updated.permissions),
          disabled: updated.disabled,
          description: updated.description,
          allowedIps: updated.allowedIps,
          expiresAt: updated.expiresAt,
        },
      });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  router.post('/clients/:name/rotate-key', (req, res) => {
    try {
      const result = clients.rotateKey(req.params.name);
      events.broadcast('client_change', { action: 'rotate_key', name: req.params.name });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'KEY_ROTATED', target: req.params.name });
      log(`Admin rotated key for client "${req.params.name}"`);
      res.json({ ok: true, name: req.params.name, key: result.key });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  router.delete('/clients/:name', (req, res) => {
    try {
      clients.deleteClient(req.params.name);
      events.broadcast('client_change', { action: 'delete', name: req.params.name });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'CLIENT_DELETED', target: req.params.name });
      log(`Admin deleted client "${req.params.name}"`);
      res.json({ ok: true, message: `Client "${req.params.name}" deleted` });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  // Memory Cache API
  router.get('/cache', (req, res) => {
    res.json(github.getCacheStats());
  });

  router.post('/cache/clear', (req, res) => {
    const { pattern } = req.body || {};
    const count = github.clearCache(pattern || null);
    events.broadcast('cache_clear', { pattern: pattern || 'all', count, time: new Date().toISOString() });
    audit?.record({ actor: 'admin', ip: req.ip, action: 'CACHE_PURGED', target: pattern || 'all', details: { count } });
    res.json({ ok: true, clearedEntries: count });
  });

  // Disk Asset Cache API
  router.get('/asset-cache', (req, res) => {
    res.json(assetCache ? assetCache.getStats() : { enabled: false });
  });

  router.post('/asset-cache/prefetch', async (req, res) => {
    const { owner, repo, assetId, name } = req.body || {};
    if (!owner || !repo || !assetId) {
      return res.status(400).json({ error: 'bad_request', message: 'owner, repo and assetId required' });
    }
    if (!assetCache?.enabled) {
      return res.status(400).json({ error: 'cache_disabled', message: 'Asset cache is disabled' });
    }

    try {
      const upstream = await github.stream(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${assetId}`, {
        accept: 'application/octet-stream',
      });

      if (!upstream.ok || !upstream.body) {
        return res.status(502).json({ error: 'upstream_failed', message: `Upstream error ${upstream.status}` });
      }

      const stream = Readable.fromWeb(upstream.body);
      const meta = {
        name: name || `asset_${assetId}`,
        contentType: upstream.headers.get('content-type') || 'application/octet-stream',
        contentDisposition: upstream.headers.get('content-disposition') || '',
        etag: upstream.headers.get('etag') || '',
      };

      // Stream to disk
      assetCache.cacheAssetStream(assetId, stream, meta).then(() => {
        events.broadcast('asset_cached', { assetId, name: meta.name });
      });

      audit?.record({ actor: 'admin', ip: req.ip, action: 'ASSET_PREFETCHED', target: `${owner}/${repo}#${assetId}` });
      res.json({ ok: true, message: `Prefetching started for asset ${assetId}` });
    } catch (e) {
      res.status(502).json({ error: 'upstream_error', message: e.message });
    }
  });

  router.delete('/asset-cache/:id', (req, res) => {
    if (!assetCache) return res.json({ ok: true, deleted: false });
    const deleted = assetCache.delete(req.params.id);
    audit?.record({ actor: 'admin', ip: req.ip, action: 'ASSET_PURGED', target: req.params.id });
    res.json({ ok: true, deleted });
  });

  // Diagnostics & upstream check
  router.get('/diagnostics', async (req, res) => {
    const diag = await github.diagnose();
    res.json(diag);
  });

  // Recent logs
  router.get('/logs', (req, res) => {
    res.json(metrics.getRecentLogs());
  });

  // Repos & Releases Explorer
  router.get('/repos', async (req, res) => {
    try {
      const list = await github.json('/user/repos?per_page=100&sort=updated');
      const repos = list.map((r) => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
        description: r.description,
        default_branch: r.default_branch,
        updated_at: r.updated_at,
      }));
      res.json(repos);
    } catch (e) {
      res.status(502).json({ error: 'upstream_error', message: e.message });
    }
  });

  router.get('/repos/:owner/:repo/releases', async (req, res) => {
    const { owner, repo } = req.params;
    try {
      const list = await github.json(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=20`);
      const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      const mapped = list.map((rel) => ({
        id: rel.id,
        tag_name: rel.tag_name,
        name: rel.name,
        body: rel.body,
        draft: rel.draft,
        prerelease: rel.prerelease,
        published_at: rel.published_at,
        assets: (rel.assets || []).map((a) => ({
          id: a.id,
          name: a.name,
          size: a.size,
          content_type: a.content_type,
          download_url: `${base}/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${a.id}`,
          cachedLocally: assetCache ? assetCache.has(a.id) : false,
        })),
      }));
      res.json(mapped);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'upstream_error', message: e.message });
    }
  });

  // Interactive API Sandbox Tester
  router.post('/tester', async (req, res) => {
    const { path: reqPath, method = 'GET', clientKey, clientName } = req.body || {};
    if (!reqPath || !reqPath.startsWith('/v1/')) {
      return res.status(400).json({ error: 'bad_request', message: 'Path must begin with /v1/' });
    }

    const start = Date.now();
    const host = req.get('host');
    const url = `${req.protocol}://${host}${reqPath}`;

    try {
      const headers = {};

      if (clientKey) {
        headers['Authorization'] = `Bearer ${clientKey}`;
      } else if (clientName) {
        // Authenticated admin can simulate any configured client directly
        headers['X-Nexus-Simulate-Client'] = clientName;
        headers['X-Admin-Token'] = config.adminToken;
      }

      const upstreamRes = await fetch(url, { method, headers });
      const latencyMs = Date.now() - start;
      const status = upstreamRes.status;

      let responseBody;
      const contentType = upstreamRes.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        responseBody = await upstreamRes.json();
      } else {
        const text = await upstreamRes.text();
        responseBody = text.length > 2000 ? text.slice(0, 2000) + '... (truncated)' : text;
      }

      const resHeaders = {};
      upstreamRes.headers.forEach((v, k) => { resHeaders[k] = v; });

      res.json({
        ok: upstreamRes.ok,
        status,
        latencyMs,
        headers: resHeaders,
        body: responseBody,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
        latencyMs: Date.now() - start,
      });
    }
  });

  return router;
}
