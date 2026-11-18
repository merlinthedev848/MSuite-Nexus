export class UpstreamError extends Error {
  constructor(status, detail) {
    super(`GitHub responded ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'MSuite-CodeHandler';

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export class GitHub {
  constructor({ token, apiUrl, cacheTtlMs = 60000, cacheMaxEntries = 500, fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.apiOrigin = new URL(apiUrl).origin;
    this.cacheTtlMs = cacheTtlMs;
    this.cacheMaxEntries = cacheMaxEntries;
    this.fetch = fetchImpl;
    this.cache = new Map();
  }

  authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  /** GET a JSON API path with a TTL + ETag cache. */
  async json(path) {
    const now = Date.now();
    const hit = this.cache.get(path);
    if (hit && hit.expires > now) return hit.value;

    const headers = this.authHeaders({ Accept: 'application/vnd.github+json' });
    if (hit?.etag) headers['If-None-Match'] = hit.etag;

    const res = await this.fetch(this.apiUrl + path, { headers });
    if (res.status === 304 && hit) {
      hit.expires = now + this.cacheTtlMs;
      return hit.value;
    }
    if (!res.ok) throw new UpstreamError(res.status, await safeText(res));

    const value = await res.json();
    if (this.cacheTtlMs > 0) {
      this.cache.delete(path);
      this.cache.set(path, { value, etag: res.headers.get('etag'), expires: now + this.cacheTtlMs });
      while (this.cache.size > this.cacheMaxEntries) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }

  /**
   * GET binary content. Redirects are followed manually so the GitHub token is only
   * ever sent to the GitHub API origin, never to signed storage/codeload URLs.
   */
  async stream(path, { accept = 'application/octet-stream', range } = {}) {
    let url = new URL(this.apiUrl + path);
    const extra = range ? { Range: range } : {};
    let res = await this.fetch(url, {
      headers: this.authHeaders({ Accept: accept, ...extra }),
      redirect: 'manual',
    });

    for (let hops = 0; REDIRECTS.has(res.status); hops++) {
      if (hops >= 5) throw new UpstreamError(508, 'too many redirects');
      const location = res.headers.get('location');
      if (!location) throw new UpstreamError(502, 'redirect without location');
      await res.body?.cancel();
      url = new URL(location, url);
      const headers = url.origin === this.apiOrigin
        ? this.authHeaders({ Accept: accept, ...extra })
        : { 'User-Agent': USER_AGENT, Accept: accept, ...extra };
      res = await this.fetch(url, { headers, redirect: 'manual' });
    }

    if (!res.ok) throw new UpstreamError(res.status, await safeText(res));
    return res;
  }
}
