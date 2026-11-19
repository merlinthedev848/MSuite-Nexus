import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * MSuite Nexus Service Gateway & Traffic Forwarder
 * 
 * Dynamically routes incoming traffic from client applications to backend microservices,
 * injecting upstream credentials, enforcing RBAC and IP guard rules, and logging telemetry.
 */
export class ServiceGateway {
  constructor({ configFile, file, log = console.log, fetchImpl = globalThis.fetch } = {}) {
    this.configFile = configFile || file || process.env.SERVICES_FILE || path.join(process.cwd(), '.cache', 'services.json');
    this.log = log;
    this.fetch = fetchImpl;
    this.services = new Map(); // id -> serviceConfig

    const dir = path.dirname(this.configFile);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }

    this.load();
  }

  load() {
    if (!fs.existsSync(this.configFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      const list = Array.isArray(data) ? data : data?.services || [];
      this.services.clear();
      for (const s of list) {
        if (s.id && s.target) {
          this.services.set(s.id.toLowerCase().trim(), {
            id: s.id.toLowerCase().trim(),
            name: s.name || s.id,
            description: s.description || '',
            target: s.target.replace(/\/+$/, ''),
            authHeader: s.authHeader || '', // Upstream secret token injected by Nexus
            allowedClients: Array.isArray(s.allowedClients) && s.allowedClients.length ? s.allowedClients.map((c) => c.toLowerCase().trim()) : ['*'],
            enabled: s.enabled !== false,
            createdAt: s.createdAt || new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      this.log(`Failed to load services configuration: ${e.message}`);
    }
  }

  save() {
    try {
      const list = Array.from(this.services.values());
      const serialized = JSON.stringify({ services: list }, null, 2) + '\n';
      const tmp = `${this.configFile}.tmp.${Date.now()}`;
      try {
        fs.writeFileSync(tmp, serialized);
        fs.renameSync(tmp, this.configFile);
      } catch {
        fs.writeFileSync(this.configFile, serialized);
        if (fs.existsSync(tmp)) try { fs.unlinkSync(tmp); } catch {}
      }
    } catch (e) {
      this.log(`Failed to persist services configuration: ${e.message}`);
    }
  }

  getAllServices() {
    return Array.from(this.services.values()).map((s) => ({
      ...s,
      authHeaderMasked: s.authHeader ? '••••••••' : null,
    }));
  }

  getService(id) {
    if (!id) return null;
    return this.services.get(String(id).toLowerCase().trim()) || null;
  }

  registerService({ id, name, description = '', target, authHeader = '', allowedClients = ['*'], enabled = true }) {
    if (!id || !target) throw new Error('Service "id" and "target" are required');
    const cleanId = String(id).toLowerCase().trim();
    if (!/^[a-z0-9_-]{1,64}$/.test(cleanId)) throw new Error('Service id must be 1-64 alphanumeric characters, underscores or dashes');

    try {
      new URL(target);
    } catch {
      throw new Error(`Invalid target URL: ${target}`);
    }

    const serviceObj = {
      id: cleanId,
      name: name || cleanId,
      description: String(description).trim(),
      target: target.replace(/\/+$/, ''),
      authHeader: String(authHeader).trim(),
      allowedClients: Array.isArray(allowedClients) && allowedClients.length ? allowedClients.map((c) => c.toLowerCase().trim()) : ['*'],
      enabled: Boolean(enabled),
      createdAt: new Date().toISOString(),
    };

    this.services.set(cleanId, serviceObj);
    this.save();
    return serviceObj;
  }

  updateService(id, { name, description, target, authHeader, allowedClients, enabled }) {
    const service = this.getService(id);
    if (!service) throw new Error(`Service "${id}" not found`);

    if (name !== undefined) service.name = String(name).trim();
    if (description !== undefined) service.description = String(description).trim();
    if (target !== undefined) {
      try { new URL(target); } catch { throw new Error(`Invalid target URL: ${target}`); }
      service.target = target.replace(/\/+$/, '');
    }
    if (authHeader !== undefined) service.authHeader = String(authHeader).trim();
    if (allowedClients !== undefined) {
      service.allowedClients = Array.isArray(allowedClients) && allowedClients.length ? allowedClients.map((c) => c.toLowerCase().trim()) : ['*'];
    }
    if (enabled !== undefined) service.enabled = Boolean(enabled);

    this.save();
    return service;
  }

  deleteService(id) {
    const cleanId = String(id).toLowerCase().trim();
    const deleted = this.services.delete(cleanId);
    if (deleted) this.save();
    return deleted;
  }

  canClientAccess(service, client) {
    if (!service || !service.enabled) return false;
    if (!client) return false;

    // Check client permission
    const hasGlobalPermission = client.permissions.has('services') || client.permissions.has('*');
    const hasSpecificPermission = client.permissions.has(`service:${service.id}`);
    if (!hasGlobalPermission && !hasSpecificPermission) return false;

    // Check service allowedClients allow-list
    const clientName = client.name.toLowerCase();
    if (service.allowedClients.includes('*')) return true;
    return service.allowedClients.includes(clientName);
  }

  /**
   * Forward incoming HTTP request to upstream service
   */
  async forwardRequest(service, req, res) {
    const rawPath = req.params.path || req.params[0] || '';
    const subPath = rawPath
      ? `/${(Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath)).replace(/^\/+/, '')}`
      : '';
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const targetUrl = `${service.target}${subPath}${qs}`;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      // Drop hop-by-hop and host headers
      if (lk === 'host' || lk === 'connection' || lk === 'authorization' || lk === 'x-api-key' || lk === 'content-length') continue;
      headers[k] = v;
    }

    // Identify client securely to upstream
    headers['X-Forwarded-For'] = req.ip;
    headers['X-Forwarded-Proto'] = req.protocol;
    headers['X-Nexus-Client'] = req.client.name;
    headers['X-Nexus-Service'] = service.id;

    // Inject upstream security credentials configured in Nexus
    if (service.authHeader) {
      headers['Authorization'] = service.authHeader;
    }

    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'manual',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.rawBody) {
        fetchOptions.body = req.rawBody;
      } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        fetchOptions.body = JSON.stringify(req.body);
        if (!headers['content-type']) headers['content-type'] = 'application/json';
      }
    }

    let upstreamRes;
    try {
      upstreamRes = await this.fetch(targetUrl, fetchOptions);
    } catch (e) {
      this.log(`Gateway forward failed for service "${service.id}" (${targetUrl}): ${e.message}`);
      return res.status(502).json({
        error: 'gateway_upstream_error',
        message: `Failed to reach upstream service "${service.id}": ${e.message}`,
      });
    }

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk !== 'transfer-encoding' && lk !== 'connection') {
        res.set(k, v);
      }
    });
    res.set('X-Nexus-Gateway', 'FORWARDED');

    if (!upstreamRes.body) return res.end();
    await pipeline(Readable.fromWeb(upstreamRes.body), res);
  }
}
