import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';

export const PERMISSIONS = ['releases', 'raw', 'archive'];

export const hashKey = (key) => createHash('sha256').update(String(key), 'utf8').digest('hex');
export const generateKey = () => 'msk_' + randomBytes(32).toString('base64url');

/**
 * clients.json format:
 * {
 *   "clients": [
 *     { "name": "msuite-sip", "keyHash": "<sha256 hex>", "repos": ["owner/repo", "owner/*"],
 *       "permissions": ["releases", "raw", "archive"], "disabled": false }
 *   ]
 * }
 */
export function parseClients(data) {
  const list = Array.isArray(data) ? data : data?.clients;
  if (!Array.isArray(list)) throw new Error('clients file must contain a "clients" array');

  const byHash = new Map();
  const names = new Set();
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || !c.name) throw new Error('client entry is missing "name"');
    if (!/^[a-f0-9]{64}$/i.test(c.keyHash || '')) throw new Error(`client "${c.name}" has an invalid keyHash`);
    if (names.has(c.name)) throw new Error(`duplicate client name "${c.name}"`);
    names.add(c.name);
    if (c.disabled) continue;

    const perms = c.permissions ?? PERMISSIONS;
    for (const p of perms) {
      if (!PERMISSIONS.includes(p)) throw new Error(`client "${c.name}" has unknown permission "${p}"`);
    }
    byHash.set(c.keyHash.toLowerCase(), {
      name: c.name,
      repos: (c.repos || []).map((r) => String(r).toLowerCase()),
      permissions: new Set(perms),
    });
  }
  return byHash;
}

export class ClientStore {
  constructor(file) {
    this.file = file;
    this.byHash = new Map();
  }

  static fromObject(data) {
    const s = new ClientStore(null);
    s.byHash = parseClients(data);
    return s;
  }

  load() {
    this.byHash = parseClients(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    return this.byHash.size;
  }

  /** Hot-reload the clients file when it changes; a bad edit keeps the previous config. */
  watch(log = () => {}) {
    if (!this.file) return;
    fs.watchFile(this.file, { interval: 5000 }, () => {
      try {
        log(`clients reloaded (${this.load()} active)`);
      } catch (e) {
        log(`clients reload failed, keeping previous config: ${e.message}`);
      }
    });
  }

  unwatch() {
    if (this.file) fs.unwatchFile(this.file);
  }

  authenticate(key) {
    if (!key || typeof key !== 'string') return null;
    return this.byHash.get(hashKey(key)) || null;
  }
}

export function canAccess(client, owner, repo, permission) {
  if (!client.permissions.has(permission)) return false;
  const o = owner.toLowerCase();
  const full = `${o}/${repo.toLowerCase()}`;
  return client.repos.some((p) => p === '*' || p === full || p === `${o}/*`);
}
