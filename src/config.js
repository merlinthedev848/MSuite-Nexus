import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function loadConfig(env = process.env) {
  const num = (v, d) => {
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric config value: ${v}`);
    return n;
  };

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
    servicesFile: env.SERVICES_FILE || './services.json',
    adminToken: env.ADMIN_TOKEN || env.ADMIN_PASSWORD || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    cacheTtlMs: num(env.CACHE_TTL_SECONDS, 60) * 1000,
    cacheMaxEntries: num(env.CACHE_MAX_ENTRIES, 500),
    rateLimitPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 120),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    logRequests: env.LOG_REQUESTS !== 'false',

    // Asset disk cache
    assetCacheEnabled: env.ASSET_CACHE_ENABLED !== 'false',
    assetCacheDir: env.ASSET_CACHE_DIR || path.join(process.cwd(), '.cache', 'assets'),
    assetCacheMaxBytes: num(env.ASSET_CACHE_MAX_GB, 10) * 1024 * 1024 * 1024,

    // Audit log
    auditLogFile: env.AUDIT_LOG_FILE || path.join(process.cwd(), '.cache', 'audit.jsonl'),
  };

  cfg.setupRequired = !cfg.githubTokens.length;

  if (!cfg.adminToken) {
    cfg.adminToken = 'msuite_adm_' + randomBytes(24).toString('base64url');
    cfg.adminTokenGenerated = true;
  }

  return cfg;
}
