import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { canAccess, isIpAllowed, isClientExpired } from './clients.js';
import { UpstreamError } from './github.js';
import { compareVersions } from './version.js';
import { createAdminRouter } from './admin.js';
import { createWebhookHandler } from './webhook.js';
import { generateOpenApiSpec } from './openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const validName = (s) => NAME_RE.test(s) && s !== '.' && s !== '..';
const enc = (s) => encodeURIComponent(s);

function extractKey(req) {
  const auth = req.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return req.get('x-api-key') || null;
}

function validRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 255 &&
    !ref.includes('..') && !/[\s~^:?*\[\\]/.test(ref) && !ref.startsWith('/') && !ref.endsWith('/');
}

export function createApp({ config, clients, github, metrics, events, assetCache = null, audit = null, gateway = null, bus = null, log = console.log }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const baseUrl = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

  const checkAdminToken = (input) => {
    if (!input || typeof input !== 'string') return false;
    const expected = Buffer.from(config.adminToken, 'utf8');
    const actual = Buffer.from(input, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  };

  // Preserve raw body on webhook route for HMAC verification
  app.use('/v1/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body.toString('utf8');
      try {
        req.body = JSON.parse(req.rawBody);
      } catch {
        req.body = {};
      }
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  // Static files for the modern MSuite Admin UI
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { maxAge: '1h', index: 'index.html' }));

  // Prometheus Metrics endpoint
  app.get('/metrics', (req, res) => {
    const rateLimits = github.getRateLimits();
    const assetStats = assetCache?.getStats();
    res.type('text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.toPrometheusText(rateLimits, assetStats));
  });

  // OpenAPI 3.1 Specification endpoint
  const openApiHandler = (req, res) => {
    const spec = generateOpenApiSpec({ publicBaseUrl: baseUrl(req) });
    res.json(spec);
  };
  app.get('/openapi.json', openApiHandler);
  app.get('/api/openapi.json', openApiHandler);

  // CORS support for web clients, Electron/Tauri apps, and portals
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, X-API-Key, Content-Type, Range, If-None-Match, If-Modified-Since');
    res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition, ETag, X-Checksum-Sha256, Digest, X-Nexus-Gateway, Retry-After');
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  // --- security headers + telemetry logging ---
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });

    const start = Date.now();
    let bytesSent = 0;

    const origWrite = res.write;
    const origEnd = res.end;
    res.write = function (chunk, ...args) {
      if (chunk && typeof chunk !== 'function') {
        bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return origWrite.call(this, chunk, ...args);
    };
    res.end = function (chunk, ...args) {
      if (chunk && typeof chunk !== 'function') {
        bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return origEnd.call(this, chunk, ...args);
    };

    res.on('finish', () => {
      const ms = Date.now() - start;
      const clientName = req.client?.name ?? null;
      const isApiTraffic = req.path.startsWith('/v1/') || req.path.startsWith('/api/');

      if (isApiTraffic && metrics) {
        const logEntry = metrics.recordRequest({
          client: clientName,
          ip: req.ip,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms,
          bytes: bytesSent,
        });

        events?.broadcast('log', logEntry);
      }

      if (config.logRequests && isApiTraffic) {
        log(JSON.stringify({
          t: new Date().toISOString(),
          client: clientName,
          ip: req.ip,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms,
          bytes: bytesSent,
        }));
      }
    });

    next();
  });

  // Liveness health check
  app.get('/health', (req, res) => res.json({
    ok: true,
    service: 'MSuite Nexus',
    version: '2.0.0',
    uptimeSec: metrics ? Math.floor((Date.now() - metrics.startTime) / 1000) : 0,
    activeClients: clients.byHash.size,
    assetCacheEnabled: Boolean(assetCache?.enabled),
    timestamp: new Date().toISOString(),
  }));

  // Mount GitHub Webhook receiver
  app.post('/v1/webhook', createWebhookHandler({
    github,
    events,
    secret: config.webhookSecret,
    log,
  }));

  // Mount Admin API router
  if (metrics && events) {
    app.use('/api/admin', createAdminRouter({ config, clients, github, metrics, events, assetCache, audit, gateway, bus, log }));
  }

  // --- Client /v1 API ---
  const windows = new Map();
  const v1 = express.Router();

  v1.use((req, res, next) => {
    let client = null;

    // Check for admin sandbox client simulation
    const simClientName = req.get('x-nexus-simulate-client');
    const simAdminToken = req.get('x-admin-token');
    if (simClientName && simAdminToken && checkAdminToken(simAdminToken)) {
      client = clients.getClient(simClientName);
      if (!client) {
        return next(new HttpError(404, 'client_not_found', `Simulated client "${simClientName}" not found`));
      }
    } else {
      client = clients.authenticate(extractKey(req));
    }

    if (!client) return next(new HttpError(401, 'unauthorized', 'Missing or invalid API key'));

    // Check expiration
    if (isClientExpired(client)) {
      return next(new HttpError(401, 'key_expired', 'Client API key has expired'));
    }

    // Check IP allow-list
    if (!isIpAllowed(client, req.ip)) {
      return next(new HttpError(403, 'ip_forbidden', `IP address ${req.ip} is not permitted for this client key`));
    }

    req.client = client;

    const clientLimit = typeof client.rateLimit === 'number' && client.rateLimit >= 0
      ? client.rateLimit
      : config.rateLimitPerMinute;

    if (clientLimit > 0) {
      const minute = Math.floor(Date.now() / 60000);
      let w = windows.get(client.name);
      if (!w || w.minute !== minute) {
        w = { minute, count: 0 };
        windows.set(client.name, w);
      }
      w.count++;
      res.set('X-RateLimit-Limit', String(clientLimit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, clientLimit - w.count)));
      if (w.count > clientLimit) {
        res.set('Retry-After', String(60 - Math.floor((Date.now() / 1000) % 60)));
        return next(new HttpError(429, 'rate_limited', 'Too many requests'));
      }
    }
    next();
  });

  v1.get('/me', (req, res) => {
    res.json({
      name: req.client.name,
      repos: req.client.repos,
      permissions: [...req.client.permissions],
      allowedIps: req.client.allowedIps,
      expiresAt: req.client.expiresAt,
      rateLimit: req.client.rateLimit ?? config.rateLimitPerMinute,
    });
  });

  const repoGuard = (permission) => (req, res, next) => {
    const { owner, repo } = req.params;
    if (!validName(owner) || !validName(repo)) return next(new HttpError(400, 'bad_request', 'Invalid owner or repo'));
    if (!canAccess(req.client, owner, repo, permission)) {
      return next(new HttpError(403, 'forbidden', `Client not allowed ${permission} access to ${owner}/${repo}`));
    }
    next();
  };

  const mapRelease = (req, rel) => {
    const { owner, repo } = req.params;
    const base = baseUrl(req);
    return {
      id: rel.id,
      tag_name: rel.tag_name,
      name: rel.name,
      body: rel.body,
      draft: rel.draft,
      prerelease: rel.prerelease,
      created_at: rel.created_at,
      published_at: rel.published_at,
      assets: (rel.assets || []).map((a) => {
        const cachedMeta = assetCache?.has(a.id) ? assetCache.getMeta(a.id) : null;
        return {
          id: a.id,
          name: a.name,
          label: a.label,
          size: a.size,
          content_type: a.content_type,
          sha256: cachedMeta?.sha256 || null,
          updated_at: a.updated_at,
          download_url: `${base}/v1/repos/${enc(owner)}/${enc(repo)}/releases/assets/${a.id}`,
        };
      }),
    };
  };

  const repoPath = (req) => `/repos/${enc(req.params.owner)}/${enc(req.params.repo)}`;

  const findReleaseForChannel = async (req, channel = 'stable') => {
    const list = await github.json(`${repoPath(req)}/releases?per_page=30`);
    const valid = list.filter((r) => !r.draft);

    if (channel === 'stable') {
      const stable = valid.find((r) => !r.prerelease && !/-alpha|-beta|-rc/i.test(r.tag_name));
      if (!stable) throw new UpstreamError(404, 'no stable release found');
      return stable;
    }

    const newest = valid[0];
    if (!newest) throw new UpstreamError(404, 'no releases found');
    return newest;
  };

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Repositories discovery endpoint for authenticated clients (private & public)
  v1.get('/repos', wrap(async (req, res) => {
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    const list = await github.json('/user/repos?per_page=100&sort=updated&visibility=all&affiliation=owner,collaborator,organization_member');
    const filtered = (Array.isArray(list) ? list : [])
      .filter((r) => {
        const [owner, name] = (r.full_name || '').split('/');
        if (!owner || !name) return false;
        const o = owner.toLowerCase();
        const full = `${o}/${name.toLowerCase()}`;
        return req.client.repos.some((p) => p === '*' || p === full || p === `${o}/*`);
      })
      .map((r) => {
        const [owner, name] = (r.full_name || '').split('/');
        return {
          full_name: r.full_name,
          name: r.name,
          owner: r.owner?.login || owner,
          private: Boolean(r.private),
          description: r.description,
          default_branch: r.default_branch,
          updated_at: r.updated_at,
          releases_url: `${base}/v1/repos/${enc(owner)}/${enc(name)}/releases`,
          latest_release_url: `${base}/v1/repos/${enc(owner)}/${enc(name)}/releases/latest`,
          update_url: `${base}/v1/repos/${enc(owner)}/${enc(name)}/update`,
        };
      });

    res.json({
      ok: true,
      client: req.client.name,
      count: filtered.length,
      repos: filtered,
    });
  }));

  // Releases listing
  v1.get('/repos/:owner/:repo/releases', repoGuard('releases'), wrap(async (req, res) => {
    const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 10, 1), 100);
    const list = await github.json(`${repoPath(req)}/releases?per_page=${perPage}`);
    res.json(list.filter((r) => !r.draft).map((r) => mapRelease(req, r)));
  }));

  // Latest release
  v1.get('/repos/:owner/:repo/releases/latest', repoGuard('releases'), wrap(async (req, res) => {
    const channel = req.query.channel || (req.query.prerelease === 'true' ? 'beta' : 'stable');
    const rel = await findReleaseForChannel(req, channel);
    res.json(mapRelease(req, rel));
  }));

  // Release by tag
  v1.get('/repos/:owner/:repo/releases/tags/:tag', repoGuard('releases'), wrap(async (req, res) => {
    if (!validRef(req.params.tag)) throw new HttpError(400, 'bad_request', 'Invalid tag');
    const rel = await github.json(`${repoPath(req)}/releases/tags/${enc(req.params.tag)}`);
    if (rel.draft) throw new UpstreamError(404, 'draft');
    res.json(mapRelease(req, rel));
  }));

  // Download release asset (with local disk cache & Range acceleration)
  v1.get('/repos/:owner/:repo/releases/assets/:id', repoGuard('releases'), wrap(async (req, res) => {
    const assetId = req.params.id;
    if (!/^\d{1,20}$/.test(assetId)) throw new HttpError(400, 'bad_request', 'Invalid asset id');

    // 1. Check if asset is cached on disk
    if (assetCache && assetCache.has(assetId)) {
      try {
        await assetCache.serveCached(assetId, req, res);
        return;
      } catch (e) {
        log(`Cached asset read failed, falling back to upstream: ${e.message}`);
      }
    }

    // 2. Fetch from upstream GitHub
    const upstream = await github.stream(`${repoPath(req)}/releases/assets/${assetId}`, {
      accept: 'application/octet-stream',
      range: req.get('range'),
    });

    res.status(upstream.status);
    for (const h of PASSTHROUGH_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set('X-Nexus-Cache', 'MISS');

    if (!upstream.body) return res.end();

    const upstreamStream = Readable.fromWeb(upstream.body);

    if (assetCache?.enabled && upstream.status === 200) {
      const tee1 = new PassThrough();
      const tee2 = new PassThrough();

      upstreamStream.pipe(tee1);
      upstreamStream.pipe(tee2);

      const meta = {
        name: req.params.repo,
        contentType: upstream.headers.get('content-type') || 'application/octet-stream',
        contentDisposition: upstream.headers.get('content-disposition') || '',
        etag: upstream.headers.get('etag') || '',
      };

      assetCache.cacheAssetStream(assetId, tee2, meta).catch((e) => log(`Cache write error: ${e.message}`));
      await pipeline(tee1, res);
    } else {
      await pipeline(upstreamStream, res);
    }
  }));

  // Asset SHA-256 digest & metadata lookup
  v1.get('/repos/:owner/:repo/releases/assets/:id/digest', repoGuard('releases'), wrap(async (req, res) => {
    const assetId = req.params.id;
    if (!/^\d{1,20}$/.test(assetId)) throw new HttpError(400, 'bad_request', 'Invalid asset id');

    if (assetCache && assetCache.has(assetId)) {
      const meta = assetCache.getMeta(assetId);
      if (meta?.sha256) {
        return res.json({
          assetId,
          name: meta.name,
          size: meta.size,
          sha256: meta.sha256,
          digest: `sha-256=${meta.sha256Base64 || Buffer.from(meta.sha256, 'hex').toString('base64')}`,
          cachedLocally: true,
        });
      }
    }

    res.json({
      assetId,
      cachedLocally: false,
      message: 'Asset not yet cached locally on disk; download asset first to generate SHA-256 digest',
    });
  }));

  // Update check with channels: /update?current=1.2.3[&channel=stable|beta]
  v1.get('/repos/:owner/:repo/update', repoGuard('releases'), wrap(async (req, res) => {
    const current = String(req.query.current || '').trim();
    if (!current) throw new HttpError(400, 'bad_request', 'Query parameter "current" is required');

    const channel = req.query.channel || (req.query.prerelease === 'true' ? 'beta' : 'stable');
    const rel = await findReleaseForChannel(req, channel);
    const latest = mapRelease(req, rel);

    res.json({
      current,
      channel,
      latest_version: rel.tag_name,
      update_available: compareVersions(rel.tag_name, current) > 0,
      release: latest,
    });
  }));

  // Raw files
  v1.get('/repos/:owner/:repo/raw/*path', repoGuard('raw'), wrap(async (req, res) => {
    const segments = [].concat(req.params.path || []);
    if (!segments.length || segments.some((s) => !s || s === '.' || s === '..' || /[\/\\\0]/.test(s))) {
      throw new HttpError(400, 'bad_request', 'Invalid path');
    }
    const ref = req.query.ref;
    if (ref !== undefined && !validRef(ref)) throw new HttpError(400, 'bad_request', 'Invalid ref');
    const qs = ref ? `?ref=${enc(ref)}` : '';
    const upstream = await github.stream(`${repoPath(req)}/contents/${segments.map(enc).join('/')}${qs}`, {
      accept: 'application/vnd.github.raw+json',
    });
    await pipeUpstream(upstream, res, { forceDownloadType: true });
  }));

  // Source archive
  v1.get('/repos/:owner/:repo/archive', repoGuard('archive'), wrap(async (req, res) => {
    const format = (req.query.format || 'zip').toString();
    if (format !== 'zip' && format !== 'tar') throw new HttpError(400, 'bad_request', 'format must be zip or tar');
    const ref = req.query.ref;
    if (ref !== undefined && !validRef(ref)) throw new HttpError(400, 'bad_request', 'Invalid ref');
    const path = `${repoPath(req)}/${format === 'zip' ? 'zipball' : 'tarball'}${ref ? `/${enc(ref)}` : ''}`;
    const upstream = await github.stream(path, { accept: 'application/vnd.github+json' });
    await pipeUpstream(upstream, res);
  }));

  // --- MSuite Universal Service Gateway (Traffic Forwarding) ---
  const handleServiceForward = wrap(async (req, res) => {
    if (!gateway) throw new HttpError(503, 'gateway_disabled', 'Service Gateway is not enabled');
    const service = gateway.getService(req.params.serviceId);
    if (!service) throw new HttpError(404, 'service_not_found', `Service "${req.params.serviceId}" not found`);
    if (!gateway.canClientAccess(service, req.client)) {
      throw new HttpError(403, 'forbidden', `Client "${req.client.name}" is not permitted to access service "${service.id}"`);
    }
    await gateway.forwardRequest(service, req, res);
  });

  v1.all('/services/:serviceId', handleServiceForward);
  v1.all('/services/:serviceId/*path', handleServiceForward);

  // --- MSuite Real-Time Message Bus (Data Transport) ---
  v1.post('/bus/publish', wrap(async (req, res) => {
    if (!bus) throw new HttpError(503, 'bus_disabled', 'Message Bus is not enabled');
    const hasPermission = req.client.permissions.has('bus:publish') || req.client.permissions.has('*');
    if (!hasPermission) throw new HttpError(403, 'forbidden', 'Client lacking bus:publish permission');

    const { topic, payload } = req.body || {};
    if (!topic) throw new HttpError(400, 'bad_request', 'Field "topic" is required');

    const message = bus.publish({ topic, sender: req.client.name, payload: payload ?? {} });
    events?.broadcast('bus_message', { topic: message.topic, sender: message.sender, time: message.timestamp });
    res.status(202).json({ ok: true, messageId: message.id, topic: message.topic, timestamp: message.timestamp });
  }));

  v1.get('/bus/subscribe', (req, res, next) => {
    if (!bus) return next(new HttpError(503, 'bus_disabled', 'Message Bus is not enabled'));
    const hasPermission = req.client.permissions.has('bus:subscribe') || req.client.permissions.has('*');
    if (!hasPermission) return next(new HttpError(403, 'forbidden', 'Client lacking bus:subscribe permission'));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const rawTopics = req.query.topics ? String(req.query.topics).split(',') : ['*'];
    bus.addSubscriber(res, rawTopics, req.client.name);
  });

  v1.get('/bus/history', wrap(async (req, res) => {
    if (!bus) throw new HttpError(503, 'bus_disabled', 'Message Bus is not enabled');
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const topic = req.query.topic ? String(req.query.topic) : null;
    res.json(bus.getRecentMessages({ topic, limit }));
  }));

  app.use('/v1', v1);

  // 404 for unmatched API routes
  app.use('/v1', (req, res, next) => next(new HttpError(404, 'not_found', 'API route not found')));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'not_found', 'Admin route not found')));

  // SPA fallback: index.html for dashboard navigation
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/v1') && !req.path.startsWith('/api')) {
      return res.sendFile(path.join(publicDir, 'index.html'));
    }
    next(new HttpError(404, 'not_found', 'Route not found'));
  });

  // Global Error Handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal error';

    if (err instanceof HttpError) {
      ({ status, code, message } = err);
    } else if (err instanceof UpstreamError) {
      if (err.status === 404) {
        status = 404; code = 'not_found'; message = 'Not found on GitHub';
      } else if (err.status === 401 || err.status === 403) {
        status = 502; code = 'upstream_auth'; message = 'Proxy GitHub credentials rejected or rate-limited';
      } else if (err.status === 416) {
        status = 416; code = 'range_not_satisfiable'; message = 'Range not satisfiable';
      } else {
        status = 502; code = 'upstream_error'; message = `GitHub responded ${err.status}`;
      }
      log(JSON.stringify({ t: new Date().toISOString(), level: 'warn', upstream: err.status, detail: err.detail }));
    } else {
      log(JSON.stringify({ t: new Date().toISOString(), level: 'error', error: err?.stack || String(err) }));
    }

    if (res.headersSent) return res.destroy();
    res.status(status).json({ error: code, message });
  });

  return app;
}

async function pipeUpstream(upstream, res, { forceDownloadType = false } = {}) {
  res.status(upstream.status);
  for (const h of PASSTHROUGH_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  if (forceDownloadType) {
    const ct = (res.get('content-type') || '').toLowerCase();
    if (!ct || /html|xml|svg|javascript|vnd\.github/.test(ct)) res.set('content-type', 'application/octet-stream');
  }
  if (!upstream.body) return res.end();
  await pipeline(Readable.fromWeb(upstream.body), res);
}
