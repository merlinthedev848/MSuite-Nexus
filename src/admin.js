import express from 'express';
import { timingSafeEqual } from 'node:crypto';

export function createAdminRouter({ config, clients, github, metrics, events, log = console.log }) {
  const router = express.Router();
  router.use(express.json());

  // Timing-safe token comparison
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

  // Public admin login check endpoint
  router.post('/login', (req, res) => {
    const { token } = req.body || {};
    if (!checkToken(token)) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid admin token' });
    }
    res.json({ ok: true, message: 'Authenticated successfully' });
  });

  // Admin authentication guard
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

    // Initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

    // Keep-alive heartbeat every 15s
    const timer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(timer);
      }
    }, 15000);

    res.on('close', () => clearInterval(timer));
  });

  // Overview metrics snapshot
  router.get('/overview', (req, res) => {
    const snapshot = metrics.getSnapshot(github.getRateLimits());
    res.json({
      ...snapshot,
      publicBaseUrl: config.publicBaseUrl,
      sseClients: events.connectedCount,
      adminTokenGenerated: Boolean(config.adminTokenGenerated),
      activeClientsCount: clients.byHash.size,
      totalClientsCount: clients.byName.size,
    });
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
    const { name, repos, permissions, description } = req.body || {};
    try {
      const result = clients.addClient({ name, repos, permissions, description });
      events.broadcast('client_change', { action: 'add', name });
      log(`Admin added client "${name}"`);
      res.status(201).json({
        ok: true,
        client: {
          name: result.client.name,
          repos: result.client.repos,
          permissions: Array.from(result.client.permissions),
          description: result.client.description,
        },
        key: result.key, // Shown once
      });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  router.put('/clients/:name', (req, res) => {
    const { repos, permissions, disabled, description } = req.body || {};
    try {
      const updated = clients.updateClient(req.params.name, { repos, permissions, disabled, description });
      events.broadcast('client_change', { action: 'update', name: req.params.name });
      log(`Admin updated client "${req.params.name}"`);
      res.json({
        ok: true,
        client: {
          name: updated.name,
          repos: updated.repos,
          permissions: Array.from(updated.permissions),
          disabled: updated.disabled,
          description: updated.description,
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
      log(`Admin deleted client "${req.params.name}"`);
      res.json({ ok: true, message: `Client "${req.params.name}" deleted` });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  // Cache inspect & clear
  router.get('/cache', (req, res) => {
    res.json(github.getCacheStats());
  });

  router.post('/cache/clear', (req, res) => {
    const { pattern } = req.body || {};
    const count = github.clearCache(pattern || null);
    events.broadcast('cache_clear', { pattern: pattern || 'all', count, time: new Date().toISOString() });
    res.json({ ok: true, clearedEntries: count });
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

  // Repo Explorer via upstream GitHub
  router.get('/repos', async (req, res) => {
    try {
      // List repos the token has access to
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
        })),
      }));
      res.json(mapped);
    } catch (e) {
      res.status(e.status || 502).json({ error: 'upstream_error', message: e.message });
    }
  });

  return router;
}
