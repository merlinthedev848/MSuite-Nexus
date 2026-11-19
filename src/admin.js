import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

export function createAdminRouter({ config, clients, github, metrics, events, assetCache = null, audit = null, gateway = null, bus = null, log = console.log }) {
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
      gatewayServicesCount: gateway ? gateway.services.size : 0,
      busStats: bus ? bus.stats : null,
    });
  });

  // Audit Logs
  router.get('/audit', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json(audit ? audit.getEntries({ limit }) : []);
  });

  // --- Service Gateway Routes ---
  router.get('/services', (req, res) => {
    res.json(gateway ? gateway.getAllServices() : []);
  });

  router.post('/services', (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'gateway_disabled' });
    try {
      const created = gateway.registerService(req.body || {});
      events.broadcast('service_change', { action: 'register', id: created.id });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'SERVICE_REGISTERED', target: created.id, details: { target: created.target } });
      res.status(201).json({ ok: true, service: created });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  router.put('/services/:id', (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'gateway_disabled' });
    try {
      const updated = gateway.updateService(req.params.id, req.body || {});
      events.broadcast('service_change', { action: 'update', id: req.params.id });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'SERVICE_UPDATED', target: req.params.id });
      res.json({ ok: true, service: updated });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  router.delete('/services/:id', (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'gateway_disabled' });
    const deleted = gateway.deleteService(req.params.id);
    if (deleted) {
      events.broadcast('service_change', { action: 'delete', id: req.params.id });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'SERVICE_DELETED', target: req.params.id });
    }
    res.json({ ok: true, deleted });
  });

  router.post('/services/:id/test', async (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'gateway_disabled' });
    const service = gateway.getService(req.params.id);
    if (!service) return res.status(404).json({ error: 'service_not_found' });

    const start = Date.now();
    try {
      const headers = {};
      if (service.authHeader) headers['Authorization'] = service.authHeader;
      const upstreamRes = await fetch(service.target, { method: 'GET', headers, redirect: 'manual' });
      res.json({
        ok: upstreamRes.ok,
        status: upstreamRes.status,
        latencyMs: Date.now() - start,
        target: service.target,
      });
    } catch (e) {
      res.status(502).json({
        ok: false,
        error: e.message,
        latencyMs: Date.now() - start,
        target: service.target,
      });
    }
  });

  // --- Real-Time Message Bus Routes ---
  router.get('/bus', (req, res) => {
    if (!bus) return res.json({ enabled: false });
    const recent = bus.getRecentMessages({ limit: 50 });
    res.json({
      enabled: true,
      stats: bus.stats,
      recent,
    });
  });

  router.post('/bus/publish', (req, res) => {
    if (!bus) return res.status(503).json({ error: 'bus_disabled' });
    const { topic, payload } = req.body || {};
    if (!topic) return res.status(400).json({ error: 'bad_request', message: 'topic required' });

    const msg = bus.publish({ topic, sender: 'admin', payload: payload ?? {} });
    events.broadcast('bus_message', { topic: msg.topic, sender: msg.sender, time: msg.timestamp });
    audit?.record({ actor: 'admin', ip: req.ip, action: 'BUS_EVENT_PUBLISHED', target: msg.topic });
    res.status(201).json({ ok: true, message: msg });
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
    const { name, repos, permissions, description, allowedIps, expiresAt, rateLimit } = req.body || {};
    try {
      const result = clients.addClient({ name, repos, permissions, description, allowedIps, expiresAt, rateLimit });
      events.broadcast('client_change', { action: 'add', name: result.client.name });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'CLIENT_CREATED', target: result.client.name, details: { repos, permissions, rateLimit } });
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
          rateLimit: result.client.rateLimit,
        },
        key: result.key,
      });
    } catch (e) {
      res.status(400).json({ error: 'bad_request', message: e.message });
    }
  });

  router.put('/clients/:name', (req, res) => {
    const { repos, permissions, disabled, description, allowedIps, expiresAt, rateLimit } = req.body || {};
    try {
      const updated = clients.updateClient(req.params.name, { repos, permissions, disabled, description, allowedIps, expiresAt, rateLimit });
      events.broadcast('client_change', { action: 'update', name: req.params.name });
      audit?.record({ actor: 'admin', ip: req.ip, action: 'CLIENT_UPDATED', target: req.params.name, details: { disabled, rateLimit } });
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
          rateLimit: updated.rateLimit,
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
    const { path: reqPath, method = 'GET', clientKey, clientName, headers: customHeaders, body: requestBody } = req.body || {};
    if (!reqPath || !reqPath.startsWith('/v1/')) {
      return res.status(400).json({ error: 'bad_request', message: 'Path must begin with /v1/' });
    }

    const start = Date.now();
    const host = req.get('host');
    const url = `${req.protocol}://${host}${reqPath}`;

    try {
      const headers = {};
      if (customHeaders && typeof customHeaders === 'object') {
        Object.assign(headers, customHeaders);
      }

      if (clientKey) {
        headers['Authorization'] = `Bearer ${clientKey}`;
      } else if (clientName) {
        // Authenticated admin can simulate any configured client directly
        headers['X-Nexus-Simulate-Client'] = clientName;
        headers['X-Admin-Token'] = config.adminToken;
      }

      const fetchOptions = { method, headers };
      if (requestBody !== undefined && method !== 'GET' && method !== 'HEAD') {
        if (typeof requestBody === 'object') {
          headers['Content-Type'] = 'application/json';
          fetchOptions.body = JSON.stringify(requestBody);
        } else {
          headers['Content-Type'] = 'text/plain; charset=utf-8';
          fetchOptions.body = String(requestBody);
        }
      }

      const upstreamRes = await fetch(url, fetchOptions);
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

  // --- MSuite Fleet 1-Click Provisioning via Portal ---
  router.post('/fleet/provision', async (req, res) => {
    try {
      const org = req.body?.org ? String(req.body.org).trim() : 'merlinthedev848';
      const overwrite = Boolean(req.body?.overwrite);

      const FLEET_DEFINITIONS = [
        {
          name: 'msuite-fleet-universal',
          description: 'Universal Master Key for all MSuite Products',
          repos: [`${org}/*`],
          permissions: ['releases', 'raw', 'archive', 'services', 'bus:publish', 'bus:subscribe'],
        },
        {
          name: 'msuite-sip',
          description: 'MSuite SIP Desktop & VoIP Client',
          repos: [`${org}/MSuite-SIP`],
          permissions: ['releases', 'raw', 'services'],
        },
        {
          name: 'msuite-sentinel',
          description: 'MSuite Sentinel Security Agent',
          repos: [`${org}/MSuite-Sentinel`],
          permissions: ['releases', 'raw', 'services', 'bus:publish', 'bus:subscribe'],
        },
        {
          name: 'msuite-honeypot',
          description: 'MSuite HoneyPot Threat Sensor',
          repos: [`${org}/MSuite-HoneyPot`],
          permissions: ['releases', 'raw', 'services', 'bus:publish'],
        },
        {
          name: 'msuite-mstream',
          description: 'MSuite Media & Streaming Core',
          repos: [`${org}/MStream`],
          permissions: ['releases', 'raw', 'archive', 'services'],
        },
        {
          name: 'msuite-nexus',
          description: 'MSuite Nexus Central Gateway & Exchange',
          repos: [`${org}/MSuite-Nexus`],
          permissions: ['releases', 'raw', 'archive', 'services', 'bus:publish', 'bus:subscribe'],
        },
      ];

      const provisioned = [];
      const publicUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      let envText = `# MSuite Products Fleet Configuration\n# Generated via Nexus Portal: ${new Date().toISOString()}\nMSUITE_NEXUS_URL=${publicUrl}\n\n`;

      for (const def of FLEET_DEFINITIONS) {
        let key;
        const existing = clients.getClient(def.name);
        if (existing) {
          if (overwrite) {
            const rot = clients.rotateKey(def.name);
            key = rot.key;
            clients.updateClient(def.name, {
              repos: def.repos,
              permissions: def.permissions,
              description: def.description,
              disabled: false,
            });
          } else {
            key = '(Retained existing key - select Overwrite to regenerate)';
            clients.updateClient(def.name, {
              repos: def.repos,
              permissions: def.permissions,
              description: def.description,
            });
          }
        } else {
          const added = clients.addClient({
            name: def.name,
            description: def.description,
            repos: def.repos,
            permissions: def.permissions,
            allowedIps: ['*'],
          });
          key = added.key;
        }

        const envVar = def.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
        if (!key.startsWith('(')) {
          envText += `# ${def.description}\n${envVar}=${key}\n`;
        } else {
          envText += `# ${def.description}\n# ${envVar}=<existing_key>\n`;
        }

        provisioned.push({
          name: def.name,
          description: def.description,
          repos: def.repos,
          permissions: def.permissions,
          key,
          isNew: !existing || overwrite,
        });
      }

      audit?.record({ actor: 'admin', ip: req.ip, action: 'FLEET_PROVISIONED', details: { org, count: provisioned.length } });
      events?.broadcast('client_change', { action: 'fleet_provision' });

      res.json({
        ok: true,
        org,
        provisioned,
        envText,
      });
    } catch (e) {
      res.status(500).json({ error: 'server_error', message: e.message });
    }
  });

  // --- Portal Runtime Server Settings ---
  router.get('/settings', (req, res) => {
    const rateLimits = github?.getRateLimits?.() || null;
    res.json({
      ok: true,
      publicBaseUrl: config.publicBaseUrl || '',
      port: config.port,
      host: config.host || '0.0.0.0',
      trustProxy: Boolean(config.trustProxy),
      logRequests: Boolean(config.logRequests),
      rateLimitPerMinute: config.rateLimitPerMinute || 120,
      cacheTtlSeconds: Math.round((config.cacheTtlMs || 60000) / 1000),
      cacheMaxEntries: config.cacheMaxEntries || 500,
      assetCacheEnabled: Boolean(config.assetCacheEnabled),
      assetCacheDir: config.assetCacheDir || '',
      assetCacheMaxBytes: config.assetCacheMaxBytes || 0,
      webhookConfigured: Boolean(config.webhookSecret),
      githubApiUrl: config.githubApiUrl || 'https://api.github.com',
      githubTokensCount: config.githubTokens?.length || (config.githubToken ? 1 : 0),
      githubRateLimits: rateLimits,
      clientsFile: config.clientsFile || './clients.json',
      servicesFile: config.servicesFile || './services.json',
      auditLogFile: config.auditLogFile || './.cache/audit.jsonl',
    });
  });

  router.put('/settings', (req, res) => {
    const { publicBaseUrl, rateLimitPerMinute, logRequests, cacheTtlSeconds } = req.body || {};
    if (publicBaseUrl !== undefined) {
      config.publicBaseUrl = String(publicBaseUrl).trim().replace(/\/+$/, '');
    }
    if (rateLimitPerMinute !== undefined && Number.isFinite(Number(rateLimitPerMinute)) && Number(rateLimitPerMinute) > 0) {
      config.rateLimitPerMinute = Number(rateLimitPerMinute);
    }
    if (logRequests !== undefined) {
      config.logRequests = Boolean(logRequests);
    }
    if (cacheTtlSeconds !== undefined && Number.isFinite(Number(cacheTtlSeconds)) && Number(cacheTtlSeconds) > 0) {
      config.cacheTtlMs = Number(cacheTtlSeconds) * 1000;
    }

    audit?.record({ actor: 'admin', ip: req.ip, action: 'SETTINGS_UPDATED', details: { publicBaseUrl, rateLimitPerMinute, logRequests } });
    events?.broadcast('settings_change', { time: new Date().toISOString() });

    res.json({
      ok: true,
      message: 'Server settings updated successfully',
      settings: {
        publicBaseUrl: config.publicBaseUrl,
        rateLimitPerMinute: config.rateLimitPerMinute,
        logRequests: config.logRequests,
        cacheTtlSeconds: Math.round(config.cacheTtlMs / 1000),
      },
    });
  });

  // --- MSuite Nexus Interactive Setup Wizard ---
  router.post('/wizard/test-github', async (req, res) => {
    const customToken = req.body?.token?.trim();
    if (!customToken) {
      const diag = await github.diagnose();
      return res.json(diag);
    }

    const start = Date.now();
    const apiUrl = (github?.apiUrl || config.githubApiUrl || 'https://api.github.com').replace(/\/+$/, '');
    try {
      const resp = await fetch(`${apiUrl}/user`, {
        headers: {
          'Authorization': `Bearer ${customToken}`,
          'User-Agent': 'MSuite-Nexus-SetupWizard/2.0',
          'Accept': 'application/vnd.github+json',
        },
      });
      const latencyMs = Date.now() - start;
      const rateRemaining = resp.headers.get('x-ratelimit-remaining');
      const scopes = resp.headers.get('x-oauth-scopes') || 'fine-grained-or-none';

      if (!resp.ok) {
        return res.json({
          ok: false,
          status: resp.status,
          latencyMs,
          error: `GitHub rejected token with HTTP ${resp.status}`,
        });
      }

      const userData = await resp.json();
      res.json({
        ok: true,
        status: 200,
        latencyMs,
        scopes,
        rateLimit: { remaining: rateRemaining },
        user: { login: userData.login, name: userData.name, type: userData.type },
      });
    } catch (e) {
      res.json({
        ok: false,
        latencyMs: Date.now() - start,
        error: e.message,
      });
    }
  });

  router.post('/wizard/complete', async (req, res) => {
    try {
      const {
        publicBaseUrl,
        adminToken,
        rateLimitPerMinute,
        org = 'merlinthedev848',
        githubToken,
        products = {},
        service,
      } = req.body || {};

      // 1. Update server settings
      if (publicBaseUrl) {
        config.publicBaseUrl = String(publicBaseUrl).trim().replace(/\/+$/, '');
      }
      if (adminToken && typeof adminToken === 'string' && adminToken.trim().length >= 8) {
        config.adminToken = adminToken.trim();
        config.adminTokenGenerated = false;
      }
      if (rateLimitPerMinute && Number.isFinite(Number(rateLimitPerMinute)) && Number(rateLimitPerMinute) > 0) {
        config.rateLimitPerMinute = Number(rateLimitPerMinute);
      }

      // 2. Add or update GitHub token if provided
      if (githubToken && typeof githubToken === 'string' && githubToken.trim()) {
        const cleanPat = githubToken.trim();
        if (config.githubTokens && !config.githubTokens.includes(cleanPat)) {
          config.githubTokens.unshift(cleanPat);
          config.githubToken = cleanPat;
          github.tokens.unshift(cleanPat);
          github.activeTokenIndex = 0;
        }
      }

      // 3. Register service if requested
      let registeredService = null;
      if (service && service.enabled && gateway) {
        try {
          registeredService = gateway.registerService({
            id: service.id || 'telemetry',
            name: service.name || 'Sentinel Ingestion Daemon',
            target: service.target || 'http://127.0.0.1:8001',
            authHeader: service.authHeader || '',
            allowedClients: ['*'],
          });
        } catch {}
      }

      // 4. Provision Fleet Products
      const ALL_DEFS = [
        {
          key: 'universal',
          name: 'msuite-fleet-universal',
          description: 'Universal Master Key for all MSuite Products',
          repos: [`${org}/*`],
          permissions: ['releases', 'raw', 'archive', 'services', 'bus:publish', 'bus:subscribe'],
        },
        {
          key: 'sip',
          name: 'msuite-sip',
          description: 'MSuite SIP Desktop & VoIP Client',
          repos: [`${org}/MSuite-SIP`],
          permissions: ['releases', 'raw', 'services'],
        },
        {
          key: 'sentinel',
          name: 'msuite-sentinel',
          description: 'MSuite Sentinel Security Agent',
          repos: [`${org}/MSuite-Sentinel`],
          permissions: ['releases', 'raw', 'services', 'bus:publish', 'bus:subscribe'],
        },
        {
          key: 'honeypot',
          name: 'msuite-honeypot',
          description: 'MSuite HoneyPot Threat Sensor',
          repos: [`${org}/MSuite-HoneyPot`],
          permissions: ['releases', 'raw', 'services', 'bus:publish'],
        },
        {
          key: 'mstream',
          name: 'msuite-mstream',
          description: 'MSuite Media & Streaming Core',
          repos: [`${org}/MStream`],
          permissions: ['releases', 'raw', 'archive', 'services'],
        },
        {
          key: 'nexus',
          name: 'msuite-nexus',
          description: 'MSuite Nexus Central Gateway & Exchange',
          repos: [`${org}/MSuite-Nexus`],
          permissions: ['releases', 'raw', 'archive', 'services', 'bus:publish', 'bus:subscribe'],
        },
      ];

      const provisioned = [];
      const publicUrl = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      let envText = `# MSuite Products Fleet Configuration\n# Generated via Nexus Setup Wizard: ${new Date().toISOString()}\nMSUITE_NEXUS_URL=${publicUrl}\n\n`;

      for (const def of ALL_DEFS) {
        if (products[def.key] === false) continue;

        let key;
        const existing = clients.getClient(def.name);
        if (existing) {
          const rot = clients.rotateKey(def.name);
          key = rot.key;
          clients.updateClient(def.name, {
            repos: def.repos,
            permissions: def.permissions,
            description: def.description,
            disabled: false,
          });
        } else {
          const added = clients.addClient({
            name: def.name,
            description: def.description,
            repos: def.repos,
            permissions: def.permissions,
            allowedIps: ['*'],
          });
          key = added.key;
        }

        const envVar = def.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
        envText += `# ${def.description}\n${envVar}=${key}\n`;

        provisioned.push({
          name: def.name,
          description: def.description,
          repos: def.repos,
          permissions: def.permissions,
          key,
        });
      }

      audit?.record({ actor: 'admin', ip: req.ip, action: 'WIZARD_COMPLETED', details: { org, clientCount: provisioned.length } });
      events?.broadcast('client_change', { action: 'wizard_complete' });
      events?.broadcast('settings_change', { time: new Date().toISOString() });

      res.json({
        ok: true,
        message: 'MSuite Nexus setup completed successfully!',
        adminToken: config.adminToken,
        publicBaseUrl: config.publicBaseUrl,
        provisioned,
        envText,
        registeredService,
      });
    } catch (e) {
      res.status(500).json({ error: 'server_error', message: e.message });
    }
  });

  return router;
}
