import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { ClientStore, hashKey, parseClients } from '../src/clients.js';
import { GitHub } from '../src/github.js';
import { MetricsCollector } from '../src/metrics.js';
import { EventBroker } from '../src/events.js';
import { AssetCache } from '../src/asset-cache.js';
import { AuditLogger } from '../src/audit.js';
import { compareVersions } from '../src/version.js';

const TOKEN = 'ghp_test_token';
const ADMIN_TOKEN = 'adm_super_secret_token_123';
const WEBHOOK_SECRET = 'whsec_test_secret_xyz';
const KEY_A = 'msk_client_a';
const KEY_B = 'msk_client_b';
const KEY_EXPIRED = 'msk_client_expired';
const KEY_IP_LOCKED = 'msk_client_iplocked';
const seen = [];

let ghServer, ghPort, appServer, base;
let testMetrics, testEvents, testAssetCache, testAudit;
const testCacheDir = path.join(process.cwd(), '.cache', 'test_assets');

const release = (tag, extra = {}) => ({
  id: 1,
  tag_name: tag,
  name: `Release ${tag}`,
  body: 'notes',
  draft: false,
  prerelease: false,
  created_at: '2026-01-01T00:00:00Z',
  published_at: '2026-01-01T00:00:00Z',
  html_url: 'https://github.com/secret',
  assets: [{ id: 42, name: 'app.zip', size: 5, content_type: 'application/zip', url: 'https://api.github.com/x' }],
  ...extra,
});

before(async () => {
  if (fs.existsSync(testCacheDir)) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  }

  ghServer = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization });
    const json = (code, body) => {
      res.writeHead(code, {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
      res.end(JSON.stringify(body));
    };

    if (req.url.startsWith('/s3/')) {
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename=app.zip',
      });
      return res.end('ZIPPY_DATA_CONTENT');
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'bad creds' });

    const u = new URL(req.url, 'http://x');
    switch (true) {
      case u.pathname === '/user':
        return json(200, { login: 'merlinthedev848', name: 'Merlin Dev', type: 'User' });
      case u.pathname === '/user/repos':
        return json(200, [
          { full_name: 'acme/app', name: 'app', owner: { login: 'acme' }, private: true, default_branch: 'main' },
        ]);
      case u.pathname === '/repos/acme/app/releases/latest':
        return json(200, release('v1.2.0'));
      case u.pathname === '/repos/acme/app/releases':
        return json(200, [
          release('v1.3.0-beta.1', { prerelease: true }),
          release('v1.2.0'),
          release('v9.9.9', { draft: true }),
        ]);
      case u.pathname === '/repos/acme/app/releases/assets/42':
        res.writeHead(302, { location: `http://localhost:${ghPort}/s3/signed?sig=abc` });
        return res.end();
      case u.pathname === '/repos/acme/app/contents/config/settings.json':
        res.writeHead(200, { 'content-type': 'application/vnd.github.raw+json' });
        return res.end(`{"ref":"${u.searchParams.get('ref')}"}`);
      case u.pathname === '/repos/acme/app/zipball/main':
        res.writeHead(302, { location: `http://localhost:${ghPort}/s3/codeload` });
        return res.end();
      default:
        return json(404, { message: 'Not Found' });
    }
  });
  await new Promise((r) => ghServer.listen(0, r));
  ghPort = ghServer.address().port;

  const clients = ClientStore.fromObject({
    clients: [
      { name: 'a', keyHash: hashKey(KEY_A), repos: ['acme/*'] },
      { name: 'b', keyHash: hashKey(KEY_B), repos: ['acme/other'], permissions: ['releases'] },
      { name: 'off', keyHash: hashKey('msk_off'), repos: ['*'], disabled: true },
      { name: 'expired', keyHash: hashKey(KEY_EXPIRED), repos: ['*'], expiresAt: '2020-01-01T00:00:00Z' },
      { name: 'iplocked', keyHash: hashKey(KEY_IP_LOCKED), repos: ['*'], allowedIps: ['192.0.2.1'] }, // Unreachable dummy IP
    ],
  });

  const config = {
    port: 0,
    trustProxy: false,
    publicBaseUrl: 'https://proxy.example',
    rateLimitPerMinute: 1000,
    logRequests: false,
    adminToken: ADMIN_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
  };

  testMetrics = new MetricsCollector();
  testEvents = new EventBroker();
  testAudit = new AuditLogger({ logFile: path.join(testCacheDir, 'audit.jsonl') });
  testAssetCache = new AssetCache({ cacheDir: testCacheDir, enabled: true, log: () => {} });

  const github = new GitHub({
    token: TOKEN,
    apiUrl: `http://127.0.0.1:${ghPort}`,
    cacheTtlMs: 60000,
    metrics: testMetrics,
  });

  const app = createApp({
    config,
    clients,
    github,
    metrics: testMetrics,
    events: testEvents,
    assetCache: testAssetCache,
    audit: testAudit,
    log: () => {},
  });

  appServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${appServer.address().port}`;
  config.port = appServer.address().port;
});

after(() => {
  appServer?.close();
  ghServer?.close();
  if (fs.existsSync(testCacheDir)) {
    try { fs.rmSync(testCacheDir, { recursive: true, force: true }); } catch {}
  }
});

const get = (path, key = KEY_A, headers = {}) =>
  fetch(base + path, { headers: key ? { Authorization: `Bearer ${key}`, ...headers } : headers });

const adminReq = (path, method = 'GET', body = null, token = ADMIN_TOKEN) =>
  fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test('health is public', async () => {
  const r = await get('/health', null);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.ok, true);
  assert.equal(data.service, 'MSuite Nexus');
});

test('rejects missing, invalid and disabled keys', async () => {
  assert.equal((await get('/v1/me', null)).status, 401);
  assert.equal((await get('/v1/me', 'nope')).status, 401);
  assert.equal((await get('/v1/me', 'msk_off')).status, 401);
});

test('rejects expired client key', async () => {
  const res = await get('/v1/me', KEY_EXPIRED);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'key_expired');
});

test('rejects request when client IP is not in allow-list', async () => {
  const res = await get('/v1/me', KEY_IP_LOCKED);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'ip_forbidden');
});

test('accepts X-API-Key header', async () => {
  const r = await fetch(base + '/v1/me', { headers: { 'X-API-Key': KEY_A } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).name, 'a');
});

test('enforces repo allow-list and permissions', async () => {
  assert.equal((await get('/v1/repos/acme/app/releases/latest', KEY_B)).status, 403);
  assert.equal((await get('/v1/repos/acme/other/raw/x.txt', KEY_B)).status, 403);
  assert.equal((await get('/v1/repos/evil/app/releases/latest')).status, 403);
});

test('latest release is rewritten to proxy URLs and hides GitHub URLs', async () => {
  const r = await get('/v1/repos/acme/app/releases/latest');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.tag_name, 'v1.2.0');
  assert.equal(body.html_url, undefined);
  assert.equal(body.assets[0].download_url, 'https://proxy.example/v1/repos/acme/app/releases/assets/42');
  assert.equal(body.assets[0].url, undefined);
});

test('release channels: stable vs beta', async () => {
  // Stable channel ignores pre-releases
  const stable = await (await get('/v1/repos/acme/app/releases/latest?channel=stable')).json();
  assert.equal(stable.tag_name, 'v1.2.0');

  // Beta channel includes pre-releases
  const beta = await (await get('/v1/repos/acme/app/releases/latest?channel=beta')).json();
  assert.equal(beta.tag_name, 'v1.3.0-beta.1');

  // Update check with channel
  const updateStable = await (await get('/v1/repos/acme/app/update?current=1.2.0&channel=stable')).json();
  assert.equal(updateStable.update_available, false);

  const updateBeta = await (await get('/v1/repos/acme/app/update?current=1.2.0&channel=beta')).json();
  assert.equal(updateBeta.update_available, true);
  assert.equal(updateBeta.latest_version, 'v1.3.0-beta.1');
});

test('asset download streams and tees to local disk cache', async () => {
  seen.length = 0;
  const r1 = await get('/v1/repos/acme/app/releases/assets/42');
  assert.equal(r1.status, 200);
  assert.equal(await r1.text(), 'ZIPPY_DATA_CONTENT');
  assert.equal(r1.headers.get('x-nexus-cache'), 'MISS');

  // Wait for background disk write
  await new Promise((r) => setTimeout(r, 200));

  // Second request should be a local disk cache HIT
  const r2 = await get('/v1/repos/acme/app/releases/assets/42');
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('x-nexus-cache'), 'HIT');
  assert.equal(await r2.text(), 'ZIPPY_DATA_CONTENT');

  // Third request: Range request (HTTP 206 Partial Content)
  const r3 = await get('/v1/repos/acme/app/releases/assets/42', KEY_A, { Range: 'bytes=0-4' });
  assert.equal(r3.status, 206);
  assert.equal(r3.headers.get('content-range'), 'bytes 0-4/18');
  assert.equal(await r3.text(), 'ZIPPY');
});

test('Prometheus metrics endpoint (/metrics)', async () => {
  const r = await fetch(base + '/metrics');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('nexus_requests_total'));
  assert.ok(text.includes('nexus_bytes_streamed_total'));
  assert.ok(text.includes('nexus_uptime_seconds'));
});

test('raw file with ref, served with safe content type', async () => {
  const r = await get('/v1/repos/acme/app/raw/config/settings.json?ref=main');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await r.json(), { ref: 'main' });
});

test('rejects traversal and bad input', async () => {
  const rawStatus = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: appServer.address().port, path, headers: { Authorization: `Bearer ${KEY_A}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(await rawStatus('/v1/repos/acme/app/raw/a/%2e%2e/b'), 400);
  assert.equal(await rawStatus('/v1/repos/acme/app/raw/a/%2E%2E%2Fsecret'), 400);
  assert.equal((await get('/v1/repos/acme/app/raw/x?ref=../main')).status, 400);
  assert.equal((await get('/v1/repos/acme/app/releases/assets/abc')).status, 400);
  assert.equal((await get('/v1/repos/ac%24me/app/releases/latest')).status, 400);
});

test('Admin API authentication & overview', async () => {
  assert.equal((await adminReq('/api/admin/overview', 'GET', null, 'wrong')).status, 401);
  const res = await adminReq('/api/admin/overview');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.totalRequests >= 0);
  assert.equal(data.publicBaseUrl, 'https://proxy.example');
  assert.ok(data.throughput);
  assert.ok(data.assetCache);
});

test('Admin API client CRUD with IP and expiration', async () => {
  // Create client with allowed IPs
  const created = await (await adminReq('/api/admin/clients', 'POST', {
    name: 'enterprise-worker',
    repos: ['acme/app'],
    permissions: ['releases'],
    allowedIps: ['127.0.0.1', '10.0.0.0/8'],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    description: 'Enterprise internal worker',
  })).json();

  assert.equal(created.ok, true);
  assert.equal(created.client.name, 'enterprise-worker');

  // Verify access works from 127.0.0.1
  const testRes = await get('/v1/me', created.key);
  assert.equal(testRes.status, 200);

  // Check audit log recorded creation
  const auditRes = await adminReq('/api/admin/audit');
  assert.equal(auditRes.status, 200);
  const auditLogs = await auditRes.json();
  assert.ok(auditLogs.some((l) => l.action === 'CLIENT_CREATED' && l.target === 'enterprise-worker'));

  // Clean up
  await adminReq('/api/admin/clients/enterprise-worker', 'DELETE');
});

test('Admin API Sandbox tester (/api/admin/tester)', async () => {
  const res = await adminReq('/api/admin/tester', 'POST', {
    path: '/v1/me',
    method: 'GET',
    clientKey: KEY_A,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.status, 200);
  assert.equal(data.body.name, 'a');
});

test('GitHub Webhook with HMAC signature invalidates cache', async () => {
  const payload = JSON.stringify({
    action: 'published',
    repository: { full_name: 'acme/app' },
    release: { tag_name: 'v2.0.0' },
  });

  const sig = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

  const res = await fetch(base + '/v1/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'release',
      'X-Hub-Signature-256': sig,
    },
    body: payload,
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.repository, 'acme/app');
});

test('clients file validation', () => {
  assert.throws(() => parseClients({}), /clients/);
  assert.throws(() => parseClients({ clients: [{ name: 'x', keyHash: 'short' }] }), /keyHash/);
  assert.throws(() => parseClients({ clients: [{ name: 'x', keyHash: hashKey('k'), permissions: ['admin'] }] }), /permission/);
});

test('compareVersions', () => {
  assert.equal(compareVersions('v1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.2.0', 'v1.2.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.2.0', '1.2.0-beta.1'), 1);
  assert.equal(compareVersions('1.2.0-beta.2', '1.2.0-beta.10'), -1);
});
