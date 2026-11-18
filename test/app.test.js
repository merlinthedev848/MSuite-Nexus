import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { ClientStore, hashKey, parseClients } from '../src/clients.js';
import { GitHub } from '../src/github.js';
import { compareVersions } from '../src/version.js';

const TOKEN = 'ghp_test_token';
const KEY_A = 'msk_client_a';
const KEY_B = 'msk_client_b';
const seen = []; // requests received by fake GitHub

let ghServer, ghPort, appServer, base;

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
  ghServer = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization });
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

    if (req.url.startsWith('/s3/')) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename=app.zip' });
      return res.end('ZIPPY');
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'bad creds' });

    const u = new URL(req.url, 'http://x');
    switch (true) {
      case u.pathname === '/repos/acme/app/releases/latest':
        return json(200, release('v1.2.0'));
      case u.pathname === '/repos/acme/app/releases':
        return json(200, [release('v1.3.0-beta.1', { prerelease: true }), release('v1.2.0'), release('v9.9.9', { draft: true })]);
      case u.pathname === '/repos/acme/app/releases/assets/42':
        // Cross-origin redirect (localhost vs 127.0.0.1): token must NOT follow.
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
    ],
  });
  const config = { trustProxy: false, publicBaseUrl: 'https://proxy.example', rateLimitPerMinute: 1000, logRequests: false };
  const github = new GitHub({ token: TOKEN, apiUrl: `http://127.0.0.1:${ghPort}`, cacheTtlMs: 0 });
  const app = createApp({ config, clients, github, log: () => {} });
  appServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => {
  appServer?.close();
  ghServer?.close();
});

const get = (path, key = KEY_A, headers = {}) =>
  fetch(base + path, { headers: key ? { Authorization: `Bearer ${key}`, ...headers } : headers });

test('health is public', async () => {
  const r = await get('/health', null);
  assert.equal(r.status, 200);
});

test('rejects missing, invalid and disabled keys', async () => {
  assert.equal((await get('/v1/me', null)).status, 401);
  assert.equal((await get('/v1/me', 'nope')).status, 401);
  assert.equal((await get('/v1/me', 'msk_off')).status, 401);
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

test('release list filters drafts; prerelease flag picks newest non-draft', async () => {
  const list = await (await get('/v1/repos/acme/app/releases')).json();
  assert.deepEqual(list.map((x) => x.tag_name), ['v1.3.0-beta.1', 'v1.2.0']);
  const pre = await (await get('/v1/repos/acme/app/releases/latest?prerelease=true')).json();
  assert.equal(pre.tag_name, 'v1.3.0-beta.1');
});

test('asset download streams and never leaks token to redirect target', async () => {
  seen.length = 0;
  const r = await get('/v1/repos/acme/app/releases/assets/42');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ZIPPY');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename=app.zip');
  const s3 = seen.find((s) => s.url.startsWith('/s3/'));
  assert.ok(s3, 'redirect target was fetched');
  assert.equal(s3.auth, undefined);
});

test('update check', async () => {
  let body = await (await get('/v1/repos/acme/app/update?current=1.1.9')).json();
  assert.equal(body.update_available, true);
  assert.equal(body.latest_version, 'v1.2.0');
  body = await (await get('/v1/repos/acme/app/update?current=v1.2.0')).json();
  assert.equal(body.update_available, false);
  assert.equal((await get('/v1/repos/acme/app/update')).status, 400);
});

test('raw file with ref, served with safe content type', async () => {
  const r = await get('/v1/repos/acme/app/raw/config/settings.json?ref=main');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await r.json(), { ref: 'main' });
});

test('archive download', async () => {
  const r = await get('/v1/repos/acme/app/archive?ref=main&format=zip');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ZIPPY');
  assert.equal((await get('/v1/repos/acme/app/archive?format=rar')).status, 400);
});

test('rejects traversal and bad input', async () => {
  // fetch() normalizes dot-segments client-side, so send the raw path with node:http.
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

test('upstream 404 maps to 404', async () => {
  const r = await get('/v1/repos/acme/missing/releases/latest');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'not_found');
});

test('rate limiting', async () => {
  const clients = ClientStore.fromObject({ clients: [{ name: 'a', keyHash: hashKey(KEY_A), repos: ['*'] }] });
  const github = new GitHub({ token: TOKEN, apiUrl: `http://127.0.0.1:${ghPort}`, cacheTtlMs: 0 });
  const app = createApp({ config: { rateLimitPerMinute: 2, logRequests: false }, clients, github, log: () => {} });
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const url = `http://127.0.0.1:${s.address().port}/v1/me`;
  const h = { headers: { Authorization: `Bearer ${KEY_A}` } };
  assert.equal((await fetch(url, h)).status, 200);
  assert.equal((await fetch(url, h)).status, 200);
  assert.equal((await fetch(url, h)).status, 429);
  s.close();
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
