import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
  const byName = new Map();
  const names = new Set();

  for (const c of list) {
    if (!c || typeof c.name !== 'string' || !c.name) throw new Error('client entry is missing "name"');
    if (!/^[a-f0-9]{64}$/i.test(c.keyHash || '')) throw new Error(`client "${c.name}" has an invalid keyHash`);
    if (names.has(c.name)) throw new Error(`duplicate client name "${c.name}"`);
    names.add(c.name);

    const perms = c.permissions ?? PERMISSIONS;
    for (const p of perms) {
      if (!PERMISSIONS.includes(p)) throw new Error(`client "${c.name}" has unknown permission "${p}"`);
    }

    const clientObj = {
      name: c.name,
      repos: (c.repos || []).map((r) => String(r).toLowerCase()),
      permissions: new Set(perms),
      disabled: Boolean(c.disabled),
      keyHash: c.keyHash.toLowerCase(),
      createdAt: c.createdAt || null,
      description: c.description || '',
    };

    byName.set(c.name.toLowerCase(), clientObj);
    if (!clientObj.disabled) {
      byHash.set(c.keyHash.toLowerCase(), clientObj);
    }
  }

  return { byHash, byName };
}

export class ClientStore {
  constructor(file) {
    this.file = file;
    this.byHash = new Map();
    this.byName = new Map();
  }

  static fromObject(data) {
    const s = new ClientStore(null);
    const parsed = parseClients(data);
    s.byHash = parsed.byHash;
    s.byName = parsed.byName;
    return s;
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) {
      this.byHash = new Map();
      this.byName = new Map();
      return 0;
    }
    const parsed = parseClients(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    this.byHash = parsed.byHash;
    this.byName = parsed.byName;
    return this.byHash.size;
  }

  save() {
    if (!this.file) return;
    const clients = Array.from(this.byName.values()).map((c) => ({
      name: c.name,
      description: c.description || undefined,
      keyHash: c.keyHash,
      repos: c.repos,
      permissions: Array.from(c.permissions),
      disabled: c.disabled,
      createdAt: c.createdAt || new Date().toISOString(),
    }));

    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmp = `${this.file}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ clients }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

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

  getAllClients() {
    return Array.from(this.byName.values()).map((c) => ({
      name: c.name,
      description: c.description,
      repos: c.repos,
      permissions: Array.from(c.permissions),
      disabled: c.disabled,
      keyMasked: c.keyHash.slice(0, 8) + '...' + c.keyHash.slice(-8),
      createdAt: c.createdAt,
    }));
  }

  getClient(name) {
    return this.byName.get(name.toLowerCase()) || null;
  }

  addClient({ name, repos = ['*'], permissions = PERMISSIONS, description = '' }) {
    if (!name || typeof name !== 'string') throw new Error('Client name is required');
    if (this.byName.has(name.toLowerCase())) throw new Error(`Client "${name}" already exists`);

    for (const p of permissions) {
      if (!PERMISSIONS.includes(p)) throw new Error(`Unknown permission: ${p}`);
    }

    const key = generateKey();
    const keyHash = hashKey(key);

    const clientObj = {
      name,
      description,
      repos: repos.map((r) => String(r).toLowerCase()),
      permissions: new Set(permissions),
      disabled: false,
      keyHash,
      createdAt: new Date().toISOString(),
    };

    this.byName.set(name.toLowerCase(), clientObj);
    this.byHash.set(keyHash, clientObj);
    this.save();

    return { client: clientObj, key };
  }

  updateClient(name, { repos, permissions, disabled, description }) {
    const client = this.getClient(name);
    if (!client) throw new Error(`Client "${name}" not found`);

    if (repos !== undefined) {
      client.repos = repos.map((r) => String(r).toLowerCase());
    }
    if (permissions !== undefined) {
      for (const p of permissions) {
        if (!PERMISSIONS.includes(p)) throw new Error(`Unknown permission: ${p}`);
      }
      client.permissions = new Set(permissions);
    }
    if (description !== undefined) {
      client.description = String(description);
    }
    if (disabled !== undefined) {
      client.disabled = Boolean(disabled);
      if (client.disabled) {
        this.byHash.delete(client.keyHash);
      } else {
        this.byHash.set(client.keyHash, client);
      }
    }

    this.save();
    return client;
  }

  rotateKey(name) {
    const client = this.getClient(name);
    if (!client) throw new Error(`Client "${name}" not found`);

    // Remove old hash mapping
    this.byHash.delete(client.keyHash);

    const key = generateKey();
    client.keyHash = hashKey(key);

    if (!client.disabled) {
      this.byHash.set(client.keyHash, client);
    }

    this.save();
    return { key };
  }

  deleteClient(name) {
    const client = this.getClient(name);
    if (!client) throw new Error(`Client "${name}" not found`);

    this.byHash.delete(client.keyHash);
    this.byName.delete(name.toLowerCase());
    this.save();
    return true;
  }
}

export function canAccess(client, owner, repo, permission) {
  if (!client.permissions.has(permission)) return false;
  const o = owner.toLowerCase();
  const full = `${o}/${repo.toLowerCase()}`;
  return client.repos.some((p) => p === '*' || p === full || p === `${o}/*`);
}
