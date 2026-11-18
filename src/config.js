import { randomBytes } from 'node:crypto';

export function loadConfig(env = process.env) {
  const num = (v, d) => {
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric config value: ${v}`);
    return n;
  };

  // Support single token or comma-separated pool: GITHUB_TOKENS or GITHUB_TOKEN
  const rawTokens = env.GITHUB_TOKENS || env.GITHUB_TOKEN || '';
  const githubTokens = rawTokens
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const cfg = {
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    githubTokens,
    githubToken: githubTokens[0] || '',
    githubApiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    clientsFile: env.CLIENTS_FILE || './clients.json',
    adminToken: env.ADMIN_TOKEN || env.ADMIN_PASSWORD || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    cacheTtlMs: num(env.CACHE_TTL_SECONDS, 60) * 1000,
    cacheMaxEntries: num(env.CACHE_MAX_ENTRIES, 500),
    rateLimitPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 120),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    logRequests: env.LOG_REQUESTS !== 'false',
  };

  if (!cfg.githubTokens.length) {
    throw new Error('GITHUB_TOKEN (or GITHUB_TOKENS) is required');
  }

  // If no admin token provided, generate a secure random one
  if (!cfg.adminToken) {
    cfg.adminToken = 'msuite_adm_' + randomBytes(24).toString('base64url');
    cfg.adminTokenGenerated = true;
  }

  return cfg;
}
