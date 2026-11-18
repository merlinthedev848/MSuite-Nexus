export class UpstreamError extends Error {
  constructor(status, detail) {
    super(`GitHub responded ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'MSuite-CodeHandler/2.0';

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export class GitHub {
  constructor({
    token,
    tokens,
    apiUrl,
    cacheTtlMs = 60000,
    cacheMaxEntries = 500,
    fetchImpl = globalThis.fetch,
    metrics = null,
  }) {
    const list = Array.isArray(tokens) && tokens.length ? tokens : token ? [token] : [];
    if (!list.length) throw new Error('At least one GitHub token is required');

    this.tokens = list;
    this.tokenIndex = 0;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.apiOrigin = new URL(apiUrl).origin;
    this.cacheTtlMs = cacheTtlMs;
    this.cacheMaxEntries = cacheMaxEntries;
    this.fetch = fetchImpl;
    this.metrics = metrics;
    this.cache = new Map();
    this.rateLimits = new Map(); // token -> { limit, remaining, reset, used }
  }

  get activeToken() {
    return this.tokens[this.tokenIndex % this.tokens.length];
  }

  rotateToken() {
    if (this.tokens.length > 1) {
      this.tokenIndex = (this.tokenIndex + 1) % this.tokens.length;
    }
  }

  updateRateLimits(token, headers) {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const used = headers.get('x-ratelimit-used');

    if (remaining !== null) {
      this.rateLimits.set(token, {
        limit: limit ? Number(limit) : null,
        remaining: Number(remaining),
        reset: reset ? Number(reset) : null,
        resetDate: reset ? new Date(Number(reset) * 1000).toISOString() : null,
        used: used ? Number(used) : null,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  getRateLimits() {
    const current = this.rateLimits.get(this.activeToken) || null;
    return {
      activeTokenIndex: this.tokenIndex % this.tokens.length,
      totalTokens: this.tokens.length,
      current,
      all: Array.from(this.rateLimits.entries()).map(([tok, stats], idx) => ({
        tokenIndex: idx,
        masked: tok.slice(0, 4) + '...' + tok.slice(-4),
        ...stats,
      })),
    };
  }

  authHeaders(token = this.activeToken, extra = {}) {
    return {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  clearCache(pattern = null) {
    if (!pattern) {
      const count = this.cache.size;
      this.cache.clear();
      return count;
    }
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  getCacheStats() {
    return {
      size: this.cache.size,
      maxEntries: this.cacheMaxEntries,
      ttlMs: this.cacheTtlMs,
      entries: Array.from(this.cache.entries()).map(([k, v]) => ({
        path: k,
        expires: new Date(v.expires).toISOString(),
        hasEtag: !!v.etag,
      })),
    };
  }

  /** GET a JSON API path with TTL + ETag caching & token failover */
  async json(path) {
    const now = Date.now();
    const hit = this.cache.get(path);
    if (hit && hit.expires > now) {
      this.metrics?.recordCacheHit();
      return hit.value;
    }

    const token = this.activeToken;
    const headers = this.authHeaders(token, { Accept: 'application/vnd.github+json' });
    if (hit?.etag) headers['If-None-Match'] = hit.etag;

    let res = await this.fetch(this.apiUrl + path, { headers });
    this.updateRateLimits(token, res.headers);

    // If rate-limited and we have alternative tokens in the pool, try next token
    if (res.status === 403 && this.tokens.length > 1) {
      this.rotateToken();
      const nextToken = this.activeToken;
      const nextHeaders = this.authHeaders(nextToken, { Accept: 'application/vnd.github+json' });
      if (hit?.etag) nextHeaders['If-None-Match'] = hit.etag;
      res = await this.fetch(this.apiUrl + path, { headers: nextHeaders });
      this.updateRateLimits(nextToken, res.headers);
    }

    if (res.status === 304 && hit) {
      this.metrics?.recordCacheHit();
      hit.expires = now + this.cacheTtlMs;
      return hit.value;
    }

    if (!res.ok) {
      throw new UpstreamError(res.status, await safeText(res));
    }

    this.metrics?.recordCacheMiss();
    const value = await res.json();
    if (this.cacheTtlMs > 0) {
      this.cache.delete(path);
      this.cache.set(path, { value, etag: res.headers.get('etag'), expires: now + this.cacheTtlMs });
      while (this.cache.size > this.cacheMaxEntries) {
        this.cache.delete(this.cache.keys().next().value);
      }
    }
    return value;
  }

  /** GET binary content with redirect sanitation and failover */
  async stream(path, { accept = 'application/octet-stream', range } = {}) {
    let url = new URL(this.apiUrl + path);
    const extra = range ? { Range: range } : {};
    let token = this.activeToken;

    let res = await this.fetch(url, {
      headers: this.authHeaders(token, { Accept: accept, ...extra }),
      redirect: 'manual',
    });
    this.updateRateLimits(token, res.headers);

    if (res.status === 403 && this.tokens.length > 1) {
      this.rotateToken();
      token = this.activeToken;
      res = await this.fetch(url, {
        headers: this.authHeaders(token, { Accept: accept, ...extra }),
        redirect: 'manual',
      });
      this.updateRateLimits(token, res.headers);
    }

    for (let hops = 0; REDIRECTS.has(res.status); hops++) {
      if (hops >= 5) throw new UpstreamError(508, 'too many redirects');
      const location = res.headers.get('location');
      if (!location) throw new UpstreamError(502, 'redirect without location');
      await res.body?.cancel();
      url = new URL(location, url);
      const headers = url.origin === this.apiOrigin
        ? this.authHeaders(token, { Accept: accept, ...extra })
        : { 'User-Agent': USER_AGENT, Accept: accept, ...extra };
      res = await this.fetch(url, { headers, redirect: 'manual' });
    }

    if (!res.ok) throw new UpstreamError(res.status, await safeText(res));
    return res;
  }

  /** Run a diagnostic ping to test upstream GitHub connectivity and token privileges */
  async diagnose() {
    const start = Date.now();
    const token = this.activeToken;
    try {
      const res = await this.fetch(`${this.apiUrl}/user`, {
        headers: this.authHeaders(token, { Accept: 'application/vnd.github+json' }),
      });
      const latencyMs = Date.now() - start;
      this.updateRateLimits(token, res.headers);

      const scopes = res.headers.get('x-oauth-scopes') || 'fine-grained-or-none';
      let user = null;
      if (res.ok) {
        user = await res.json();
      }

      const rateLimitState = this.rateLimits.get(token) || null;

      return {
        ok: res.ok,
        status: res.status,
        latencyMs,
        tokenMasked: token.slice(0, 4) + '...' + token.slice(-4),
        scopes,
        user: user ? { login: user.login, name: user.name, type: user.type } : null,
        rateLimit: rateLimitState,
      };
    } catch (e) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - start,
        error: e.message,
      };
    }
  }
}
