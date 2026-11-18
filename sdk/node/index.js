import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * MSuite Nexus Official Client SDK (Node.js / Electron / TypeScript)
 * 
 * Provides drop-in, zero-dependency GitHub proxy connectivity for all MSuite applications.
 * Enforces secure binary distribution, automatic updates, and SHA-256 cryptographic verification.
 */
export class NexusClient {
  /**
   * @param {Object} options
   * @param {string} [options.baseUrl] - URL of your MSuite Nexus server (default: process.env.MSUITE_NEXUS_URL || 'http://localhost:8080')
   * @param {string} [options.apiKey] - App-specific API key (default: process.env.MSUITE_NEXUS_KEY)
   * @param {number} [options.timeout] - Request timeout in ms (default: 30000)
   * @param {Function} [options.fetchImpl] - Optional fetch polyfill
   */
  constructor({
    baseUrl = process.env.MSUITE_NEXUS_URL || 'http://localhost:8080',
    apiKey = process.env.MSUITE_NEXUS_KEY || '',
    timeout = 30000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!baseUrl) throw new Error('NexusClient requires baseUrl (or MSUITE_NEXUS_URL env variable)');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey.trim();
    this.timeout = timeout;
    this.fetch = fetchImpl;
  }

  get headers() {
    const h = {
      'User-Agent': 'MSuite-Nexus-Client/2.0',
      'Accept': 'application/json',
    };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  async _request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await this.fetch(url, {
        ...options,
        headers: { ...this.headers, ...options.headers },
        signal: controller.signal,
      });

      if (!res.ok) {
        let errorBody;
        try {
          errorBody = await res.json();
        } catch {
          errorBody = { message: await res.text() };
        }
        const err = new Error(errorBody.message || `Nexus request failed with HTTP ${res.status}`);
        err.status = res.status;
        err.code = errorBody.error || 'NEXUS_ERROR';
        throw err;
      }

      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Test connection and retrieve client permissions / IP guard rules
   */
  async verifyAuth() {
    const res = await this._request('/v1/me');
    return res.json();
  }

  /**
   * Check if a newer version is available on a specific release channel
   * @param {string} repo - "owner/repo" (e.g. "merlinthedev848/MSuite-SIP")
   * @param {string} currentVersion - Current app version (e.g. "1.0.0")
   * @param {Object} [options]
   * @param {'stable'|'beta'} [options.channel] - Channel to query ('stable' or 'beta')
   */
  async checkForUpdate(repo, currentVersion, { channel = 'stable' } = {}) {
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw new Error('Repo must be in "owner/repo" format');

    const qs = new URLSearchParams({ current: currentVersion, channel });
    const res = await this._request(`/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/update?${qs}`);
    const data = await res.json();

    return {
      updateAvailable: data.update_available,
      currentVersion: data.current,
      latestVersion: data.latest_version,
      channel: data.channel,
      release: data.release,
      primaryAsset: data.release?.assets?.[0] || null,
    };
  }

  /**
   * Get latest release metadata and download URLs for a repository
   */
  async getLatestRelease(repo, { channel = 'stable' } = {}) {
    const [owner, name] = repo.split('/');
    const res = await this._request(`/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest?channel=${channel}`);
    return res.json();
  }

  /**
   * List recent releases for a repository
   */
  async listReleases(repo, { perPage = 10 } = {}) {
    const [owner, name] = repo.split('/');
    const res = await this._request(`/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=${perPage}`);
    return res.json();
  }

  /**
   * Download a binary asset to disk with automatic SHA-256 cryptographic verification
   * @param {string} repo - "owner/repo"
   * @param {string|number} assetId - Asset ID
   * @param {string} destPath - Local filesystem path to save the binary
   * @param {Object} [options]
   * @param {boolean} [options.verifySha256=true] - Verify SHA-256 checksum against server digest
   * @param {Function} [options.onProgress] - Callback (bytesDownloaded, totalBytes) => void
   */
  async downloadAsset(repo, assetId, destPath, { verifySha256 = true, onProgress = null } = {}) {
    const [owner, name] = repo.split('/');
    const url = `${this.baseUrl}/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/assets/${assetId}`;

    const res = await this.fetch(url, {
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(`Failed to download asset ${assetId}: HTTP ${res.status}`);
    }

    const expectedSha256 = res.headers.get('x-checksum-sha256');
    const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tempPath = `${destPath}.tmp.${Date.now()}`;
    const fileStream = fs.createWriteStream(tempPath);
    const hasher = createHash('sha256');

    let bytesDownloaded = 0;
    const bodyStream = Readable.fromWeb(res.body);

    bodyStream.on('data', (chunk) => {
      hasher.update(chunk);
      bytesDownloaded += chunk.length;
      if (onProgress) onProgress(bytesDownloaded, totalBytes);
    });

    await pipeline(bodyStream, fileStream);

    const actualSha256 = hasher.digest('hex');

    if (verifySha256 && expectedSha256 && actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw new Error(`SHA-256 Checksum Mismatch! Expected ${expectedSha256}, calculated ${actualSha256}`);
    }

    fs.renameSync(tempPath, destPath);

    return {
      path: destPath,
      size: bytesDownloaded,
      sha256: actualSha256,
      verified: Boolean(expectedSha256 && actualSha256.toLowerCase() === expectedSha256.toLowerCase()),
    };
  }

  /**
   * Fetch a raw private file (e.g. config, schema, or license) from a repository
   */
  async fetchRawFile(repo, filePath, { ref = 'main' } = {}) {
    const [owner, name] = repo.split('/');
    const cleanPath = filePath.replace(/^\/+/, '');
    const res = await this._request(`/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${cleanPath}?ref=${encodeURIComponent(ref)}`);
    return res.text();
  }

  /**
   * Forward a request to a backend microservice through the Nexus Service Gateway
   * @param {string} serviceId - Registered service identifier
   * @param {string} [subPath=''] - Route on upstream service (e.g. '/telemetry/heartbeat')
   * @param {Object} [options] - Standard fetch options (method, headers, body)
   */
  async callService(serviceId, subPath = '', options = {}) {
    const cleanSub = subPath ? `/${subPath.replace(/^\/+/, '')}` : '';
    const res = await this._request(`/v1/services/${encodeURIComponent(serviceId)}${cleanSub}`, options);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  /**
   * Publish an event to the MSuite Real-Time Message Bus
   * @param {string} topic - Event topic (e.g. 'alerts.threat', 'sync.status')
   * @param {Object} payload - Message payload data
   */
  async publishMessage(topic, payload = {}) {
    const res = await this._request('/v1/bus/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, payload }),
    });
    return res.json();
  }

  /**
   * Retrieve recent event history for a topic
   */
  async getMessageHistory(topic = null, limit = 50) {
    const qs = new URLSearchParams();
    if (topic) qs.set('topic', topic);
    if (limit) qs.set('limit', String(limit));
    const res = await this._request(`/v1/bus/history?${qs}`);
    return res.json();
  }
}
