export function loadConfig(env = process.env) {
  const num = (v, d) => {
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric config value: ${v}`);
    return n;
  };

  const cfg = {
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    githubToken: env.GITHUB_TOKEN || '',
    githubApiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    clientsFile: env.CLIENTS_FILE || './clients.json',
    cacheTtlMs: num(env.CACHE_TTL_SECONDS, 60) * 1000,
    cacheMaxEntries: num(env.CACHE_MAX_ENTRIES, 500),
    rateLimitPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 120),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    logRequests: env.LOG_REQUESTS !== 'false',
  };

  if (!cfg.githubToken) throw new Error('GITHUB_TOKEN is required');
  return cfg;
}
