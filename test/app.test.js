import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { ClientStore, hashKey, parseClients, safeIsoDate } from '../src/clients.js';
import { GitHub } from '../src/github.js';
import { MetricsCollector } from '../src/metrics.js';
import { EventBroker } from '../src/events.js';
import { AssetCache } from '../src/asset-cache.js';
import { AuditLogger } from '../src/audit.js';
import { ServiceGateway } from '../src/gateway.js';
import { MessageBus } from '../src/bus.js';
import { compareVersions } from '../src/version.js';
import { NexusClient } from '../sdk/node/index.js';

const TOKEN = 'ghp_test_token';
const ADMIN_TOKEN = 'adm_super_secret_token_123';
const WEBHOOK_SECRET = 'whsec_test_secret_xyz';
const KEY_A = 'msk_client_a';
const KEY_B = 'msk_client_b';
const KEY_EXPIRED = 'msk_client_expired';
const KEY_IP_LOCKED = 'msk_client_iplocked';
const seen = [];

let ghServer, ghPort, appServer, base;
let testMetrics, testEvents, testAssetCache, testAudit, testGateway, testBus;
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
  testBus = new MessageBus();
  testGateway = new ServiceGateway({ configFile: path.join(testCacheDir, 'services.json'), log: () => {} });
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
    gateway: testGateway,
    bus: testBus,
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

  // Second request should be a local disk cache HIT with SHA-256 checksum headers
  const r2 = await get('/v1/repos/acme/app/releases/assets/42');
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('x-nexus-cache'), 'HIT');
  assert.equal(await r2.text(), 'ZIPPY_DATA_CONTENT');
  const sha256 = r2.headers.get('x-checksum-sha256');
  assert.ok(sha256 && sha256.length === 64, 'X-Checksum-Sha256 should be 64-char hex');
  assert.ok(r2.headers.get('digest')?.startsWith('sha-256='), 'Digest header should have sha-256');

  // Verify asset digest endpoint
  const digestRes = await get('/v1/repos/acme/app/releases/assets/42/digest');
  assert.equal(digestRes.status, 200);
  const digestData = await digestRes.json();
  assert.equal(digestData.cachedLocally, true);
  assert.equal(digestData.sha256, sha256);

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
  // Test direct key test
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

  // Test client impersonation simulation by name
  const simRes = await adminReq('/api/admin/tester', 'POST', {
    path: '/v1/me',
    method: 'GET',
    clientName: 'b',
  });
  assert.equal(simRes.status, 200);
  const simData = await simRes.json();
  assert.equal(simData.ok, true);
  assert.equal(simData.status, 200);
  assert.equal(simData.body.name, 'b');

  // Test POST with payload and custom headers in sandbox tester
  const hookPayload = JSON.stringify({ action: 'ping' });
  const hookSig = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(hookPayload).digest('hex');

  const postRes = await adminReq('/api/admin/tester', 'POST', {
    path: '/v1/webhook',
    method: 'POST',
    headers: {
      'X-GitHub-Event': 'ping',
      'X-Hub-Signature-256': hookSig,
    },
    body: { action: 'ping' },
  });
  assert.equal(postRes.status, 200);
  const postData = await postRes.json();
  assert.equal(postData.status, 200);
  assert.equal(postData.body.ok, true);
  assert.equal(postData.body.message, 'pong');
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

test('safeIsoDate and resilient AuditLogger parsing', () => {
  assert.equal(safeIsoDate(null), null);
  assert.equal(safeIsoDate(''), null);
  assert.equal(safeIsoDate('not-a-valid-date'), null);
  assert.equal(safeIsoDate('2026-11-18T10:00:00Z'), '2026-11-18T10:00:00.000Z');

  const testAuditFile = path.join(testCacheDir, 'corrupted_audit.jsonl');
  fs.mkdirSync(path.dirname(testAuditFile), { recursive: true });
  // Write one valid line, one corrupted line, and one valid line
  fs.writeFileSync(
    testAuditFile,
    JSON.stringify({ action: 'FIRST' }) + '\n' +
    'CORRUPTED_JSON_LINE\n' +
    JSON.stringify({ action: 'SECOND' }) + '\n'
  );

  const logger = new AuditLogger({ logFile: testAuditFile });
  const entries = logger.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'SECOND');
  assert.equal(entries[1].action, 'FIRST');
});

test('OpenAPI 3.1 specification endpoint (/openapi.json)', async () => {
  const res = await fetch(base + '/openapi.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  const spec = await res.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'MSuite Nexus API');
  assert.ok(spec.paths['/v1/repos/{owner}/{repo}/update']);
  assert.ok(spec.paths['/v1/repos/{owner}/{repo}/releases/assets/{id}']);
  assert.ok(spec.paths['/v1/repos/{owner}/{repo}/releases/assets/{id}/digest']);
});

test('Per-client custom rate limit enforcement', async () => {
  // Create client with tight rateLimit: 2 requests per minute
  const clientRes = await adminReq('/api/admin/clients', 'POST', {
    name: 'rate-limited-worker',
    repos: ['*'],
    permissions: ['releases'],
    rateLimit: 2,
  });
  assert.equal(clientRes.status, 201);
  const clientData = await clientRes.json();
  const workerKey = clientData.key;

  // Req 1: allowed
  const r1 = await get('/v1/me', workerKey);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('x-ratelimit-limit'), '2');
  assert.equal(r1.headers.get('x-ratelimit-remaining'), '1');

  // Req 2: allowed
  const r2 = await get('/v1/me', workerKey);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('x-ratelimit-remaining'), '0');

  // Req 3: throttled with 429
  const r3 = await get('/v1/me', workerKey);
  assert.equal(r3.status, 429);
  assert.ok(r3.headers.get('retry-after'));

  // Clean up
  await adminReq('/api/admin/clients/rate-limited-worker', 'DELETE');
});

test('NexusClient SDK end-to-end (updates, releases, downloads with SHA-256)', async () => {
  const client = new NexusClient({ baseUrl: base, apiKey: KEY_A });

  // 1. Verify Auth
  const me = await client.verifyAuth();
  assert.equal(me.name, 'a');

  // 2. Check for update
  const update = await client.checkForUpdate('acme/app', '1.0.0', { channel: 'stable' });
  assert.equal(update.updateAvailable, true);
  assert.equal(update.latestVersion, 'v1.2.0');
  assert.equal(update.primaryAsset.name, 'app.zip');

  // 3. Download asset with SHA-256 cryptographic verification
  const downloadDest = path.join(testCacheDir, 'client_downloaded.bin');
  const result = await client.downloadAsset('acme/app', 42, downloadDest, { verifySha256: true });
  assert.equal(result.size, 18);
  assert.equal(fs.readFileSync(downloadDest, 'utf8'), 'ZIPPY_DATA_CONTENT');
  assert.ok(result.sha256 && result.sha256.length === 64);
  assert.equal(result.verified, true);

  // 4. Fetch raw file
  const raw = await client.fetchRawFile('acme/app', 'config/settings.json', { ref: 'main' });
  assert.deepEqual(JSON.parse(raw), { ref: 'main' });
});

test('ServiceGateway: registration, traffic proxying, auth injection & client restrictions', async () => {
  // Spin up a mock backend microservice (e.g. SIP signaling or telemetry)
  const backendReceived = [];
  const backendServer = http.createServer((req, res) => {
    backendReceived.push({
      url: req.url,
      method: req.method,
      auth: req.headers.authorization,
      nexusClient: req.headers['x-nexus-client'],
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'telemetry_received', ok: true }));
  });

  try {
    await new Promise((r) => backendServer.listen(0, '127.0.0.1', r));
    const backendPort = backendServer.address().port;

    // 1. Admin registers the service with injected auth token
    const regRes = await adminReq('/api/admin/services', 'POST', {
      id: 'telemetry',
      name: 'Sentinel Ingestion',
      target: `http://127.0.0.1:${backendPort}`,
      authHeader: 'Bearer internal_secret_backend_token',
      allowedClients: ['a'], // only client 'a' permitted
    });
    assert.equal(regRes.status, 201);

    // 2. Grant client 'a' services permission via Admin API
    await adminReq('/api/admin/clients/a', 'PUT', {
      permissions: ['releases', 'raw', 'archive', 'services'],
    });

    // 3. Client 'a' proxies a request through Nexus to the backend service
    const client = new NexusClient({ baseUrl: base, apiKey: KEY_A });
    const serviceResp = await client.callService('telemetry', '/ping', { method: 'POST' });
    assert.equal(serviceResp.ok, true);
    assert.equal(serviceResp.status, 'telemetry_received');

    // Verify backend received injected credentials and client identity
    assert.equal(backendReceived.length, 1);
    assert.equal(backendReceived[0].url, '/ping');
    assert.equal(backendReceived[0].auth, 'Bearer internal_secret_backend_token');
    assert.equal(backendReceived[0].nexusClient, 'a');

    // 4. Client 'b' tries to call service -> rejected with 403 (unauthorized client)
    const clientB = new NexusClient({ baseUrl: base, apiKey: KEY_B });
    await assert.rejects(
      () => clientB.callService('telemetry', '/ping'),
      (err) => err.status === 403 || /forbidden|permitted/i.test(err.message)
    );
  } finally {
    backendServer.close();
  }
});

test('MessageBus: publish events, history, and topic isolation', async () => {
  // Grant client 'a' bus permissions
  await adminReq('/api/admin/clients/a', 'PUT', {
    permissions: ['releases', 'raw', 'archive', 'services', 'bus:publish', 'bus:subscribe'],
  });

  const client = new NexusClient({ baseUrl: base, apiKey: KEY_A });

  // 1. Client publishes threat alert
  const pubRes = await client.publishMessage('alerts.threat', { ip: '198.51.100.1', severity: 'critical' });
  assert.equal(pubRes.ok, true);
  assert.equal(pubRes.topic, 'alerts.threat');

  // 2. Fetch history
  const history = await client.getMessageHistory('alerts.*');
  assert.ok(history.length >= 1);
  assert.equal(history[0].topic, 'alerts.threat');
  assert.equal(history[0].payload.ip, '198.51.100.1');
  assert.equal(history[0].sender, 'a');

  // 3. Admin can inspect bus stats
  const adminBus = await (await adminReq('/api/admin/bus')).json();
  assert.equal(adminBus.enabled, true);
  assert.ok(adminBus.stats.topics.includes('alerts.threat'));
});

test('Portal 1-Click Fleet Provisioning (/api/admin/fleet/provision)', async () => {
  const res = await adminReq('/api/admin/fleet/provision', 'POST', {
    org: 'merlinthedev848',
    overwrite: true,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.org, 'merlinthedev848');
  assert.ok(Array.isArray(data.provisioned));
  assert.equal(data.provisioned.length, 6); // Universal, SIP, Sentinel, HoneyPot, MStream, Nexus

  // Verify universal master key
  const universal = data.provisioned.find((p) => p.name === 'msuite-fleet-universal');
  assert.ok(universal);
  assert.ok(universal.key.startsWith('msk_'));
  assert.deepEqual(universal.repos, ['merlinthedev848/*']);

  // Verify SIP key
  const sip = data.provisioned.find((p) => p.name === 'msuite-sip');
  assert.ok(sip);
  assert.ok(sip.key.startsWith('msk_'));
  assert.deepEqual(sip.repos, ['merlinthedev848/MSuite-SIP']);

  // Verify generated .env text includes all product keys
  assert.ok(data.envText.includes('MSUITE_FLEET_UNIVERSAL_KEY=msk_'));
  assert.ok(data.envText.includes('MSUITE_SIP_KEY=msk_'));
  assert.ok(data.envText.includes('MSUITE_SENTINEL_KEY=msk_'));
});

test('Portal Runtime Server Settings (/api/admin/settings)', async () => {
  // 1. Fetch current settings
  const getRes = await adminReq('/api/admin/settings');
  assert.equal(getRes.status, 200);
  const settings = await getRes.json();
  assert.equal(settings.ok, true);
  assert.equal(typeof settings.rateLimitPerMinute, 'number');
  assert.equal(typeof settings.cacheTtlSeconds, 'number');
  assert.ok(settings.clientsFile);

  // 2. Update settings via Portal
  const putRes = await adminReq('/api/admin/settings', 'PUT', {
    publicBaseUrl: 'https://nexus.custom-portal.org',
    rateLimitPerMinute: 500,
    logRequests: false,
  });
  assert.equal(putRes.status, 200);
  const putData = await putRes.json();
  assert.equal(putData.ok, true);
  assert.equal(putData.settings.publicBaseUrl, 'https://nexus.custom-portal.org');
  assert.equal(putData.settings.rateLimitPerMinute, 500);
});

test('Setup Wizard: test-github connection probe', async () => {
  // Probe with valid mock token
  const res = await adminReq('/api/admin/wizard/test-github', 'POST', {
    token: TOKEN,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.user.login, 'merlinthedev848');

  // Probe without token uses configured upstream token
  const resDefault = await adminReq('/api/admin/wizard/test-github', 'POST', {});
  assert.equal(resDefault.status, 200);
  const dataDefault = await resDefault.json();
  assert.equal(dataDefault.ok, true);
});

test('Setup Wizard: complete end-to-end multi-step onboarding', async () => {
  const wizardPayload = {
    publicBaseUrl: 'https://nexus.enterprise.internal',
    adminToken: 'msuite_adm_custom_wizard_token_999',
    rateLimitPerMinute: 300,
    org: 'merlinthedev848',
    products: {
      universal: true,
      sip: true,
      sentinel: true,
      honeypot: false, // selectively omit honeypot
      mstream: true,
      nexus: true,
    },
    service: {
      enabled: true,
      id: 'telemetry-wiz',
      name: 'Sentinel Telemetry Wizard',
      target: 'http://127.0.0.1:8001',
      authHeader: 'Bearer secret_wiz_token',
    },
  };

  const res = await adminReq('/api/admin/wizard/complete', 'POST', wizardPayload);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.publicBaseUrl, 'https://nexus.enterprise.internal');
  assert.equal(data.adminToken, 'msuite_adm_custom_wizard_token_999');

  // Verify provisioned products: 5 provisioned (honeypot was omitted)
  assert.equal(data.provisioned.length, 5);
  const names = data.provisioned.map((p) => p.name);
  assert.ok(names.includes('msuite-fleet-universal'));
  assert.ok(names.includes('msuite-sip'));
  assert.ok(names.includes('msuite-sentinel'));
  assert.ok(names.includes('msuite-mstream'));
  assert.ok(names.includes('msuite-nexus'));
  assert.ok(!names.includes('msuite-honeypot'));

  // Verify service was registered
  assert.ok(data.registeredService);
  assert.equal(data.registeredService.id, 'telemetry-wiz');

  // Reset admin token back for remaining tests / suite teardown
  await adminReq('/api/admin/settings', 'PUT', { publicBaseUrl: 'https://proxy.example' }, 'msuite_adm_custom_wizard_token_999');
});
