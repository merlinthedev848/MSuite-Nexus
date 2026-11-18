import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { canAccess } from './clients.js';
import { UpstreamError } from './github.js';
import { compareVersions } from './version.js';

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

export function createApp({ config, clients, github, log = console.log }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const baseUrl = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

  // --- security headers + request log ---
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    const start = Date.now();
    res.on('finish', () => {
      if (config.logRequests) {
        log(JSON.stringify({
          t: new Date().toISOString(),
          client: req.client?.name ?? null,
          ip: req.ip,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - start,
        }));
      }
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  // --- auth ---
  const windows = new Map();
  const v1 = express.Router();

  v1.use((req, res, next) => {
    const client = clients.authenticate(extractKey(req));
    if (!client) return next(new HttpError(401, 'unauthorized', 'Missing or invalid API key'));
    req.client = client;

    if (config.rateLimitPerMinute > 0) {
      const minute = Math.floor(Date.now() / 60000);
      let w = windows.get(client.name);
      if (!w || w.minute !== minute) {
        w = { minute, count: 0 };
        windows.set(client.name, w);
      }
      w.count++;
      res.set('X-RateLimit-Limit', String(config.rateLimitPerMinute));
      res.set('X-RateLimit-Remaining', String(Math.max(0, config.rateLimitPerMinute - w.count)));
      if (w.count > config.rateLimitPerMinute) {
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
      assets: (rel.assets || []).map((a) => ({
        id: a.id,
        name: a.name,
        label: a.label,
        size: a.size,
        content_type: a.content_type,
        updated_at: a.updated_at,
        download_url: `${base}/v1/repos/${enc(owner)}/${enc(repo)}/releases/assets/${a.id}`,
      })),
    };
  };

  const repoPath = (req) => `/repos/${enc(req.params.owner)}/${enc(req.params.repo)}`;

  const latestRelease = async (req, includePrerelease) => {
    if (!includePrerelease) return github.json(`${repoPath(req)}/releases/latest`);
    const list = await github.json(`${repoPath(req)}/releases?per_page=30`);
    const rel = list.find((r) => !r.draft);
    if (!rel) throw new UpstreamError(404, 'no releases');
    return rel;
  };

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // --- releases ---
  v1.get('/repos/:owner/:repo/releases', repoGuard('releases'), wrap(async (req, res) => {
    const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 10, 1), 100);
    const list = await github.json(`${repoPath(req)}/releases?per_page=${perPage}`);
    res.json(list.filter((r) => !r.draft).map((r) => mapRelease(req, r)));
  }));

  v1.get('/repos/:owner/:repo/releases/latest', repoGuard('releases'), wrap(async (req, res) => {
    const rel = await latestRelease(req, req.query.prerelease === 'true');
    res.json(mapRelease(req, rel));
  }));

  v1.get('/repos/:owner/:repo/releases/tags/:tag', repoGuard('releases'), wrap(async (req, res) => {
    if (!validRef(req.params.tag)) throw new HttpError(400, 'bad_request', 'Invalid tag');
    const rel = await github.json(`${repoPath(req)}/releases/tags/${enc(req.params.tag)}`);
    if (rel.draft) throw new UpstreamError(404, 'draft');
    res.json(mapRelease(req, rel));
  }));

  v1.get('/repos/:owner/:repo/releases/assets/:id', repoGuard('releases'), wrap(async (req, res) => {
    if (!/^\d{1,20}$/.test(req.params.id)) throw new HttpError(400, 'bad_request', 'Invalid asset id');
    const upstream = await github.stream(`${repoPath(req)}/releases/assets/${req.params.id}`, {
      accept: 'application/octet-stream',
      range: req.get('range'),
    });
    await pipeUpstream(upstream, res);
  }));

  // Update check: /update?current=1.2.3[&prerelease=true]
  v1.get('/repos/:owner/:repo/update', repoGuard('releases'), wrap(async (req, res) => {
    const current = String(req.query.current || '').trim();
    if (!current) throw new HttpError(400, 'bad_request', 'Query parameter "current" is required');
    const rel = await latestRelease(req, req.query.prerelease === 'true');
    const latest = mapRelease(req, rel);
    res.json({
      current,
      latest_version: rel.tag_name,
      update_available: compareVersions(rel.tag_name, current) > 0,
      release: latest,
    });
  }));

  // --- raw files: /raw/path/to/file?ref=main ---
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

  // --- archives: /archive?ref=main&format=zip|tar ---
  v1.get('/repos/:owner/:repo/archive', repoGuard('archive'), wrap(async (req, res) => {
    const format = (req.query.format || 'zip').toString();
    if (format !== 'zip' && format !== 'tar') throw new HttpError(400, 'bad_request', 'format must be zip or tar');
    const ref = req.query.ref;
    if (ref !== undefined && !validRef(ref)) throw new HttpError(400, 'bad_request', 'Invalid ref');
    const path = `${repoPath(req)}/${format === 'zip' ? 'zipball' : 'tarball'}${ref ? `/${enc(ref)}` : ''}`;
    const upstream = await github.stream(path, { accept: 'application/vnd.github+json' });
    await pipeUpstream(upstream, res);
  }));

  app.use('/v1', v1);

  app.use((req, res, next) => next(new HttpError(404, 'not_found', 'Route not found')));

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
  // Never let proxied content render as HTML in a browser.
  if (forceDownloadType) {
    const ct = (res.get('content-type') || '').toLowerCase();
    if (!ct || /html|xml|svg|javascript|vnd\.github/.test(ct)) res.set('content-type', 'application/octet-stream');
  }
  if (!upstream.body) return res.end();
  await pipeline(Readable.fromWeb(upstream.body), res);
}
