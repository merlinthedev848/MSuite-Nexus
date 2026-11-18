import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Local Disk Asset Cache
 * Caches large release binary assets locally to disk, serving repeat requests
 * at LAN/NVMe speeds while fully supporting HTTP 206 Partial Content (Range requests)
 * for resumable downloads.
 */
export class AssetCache {
  constructor({ cacheDir, maxBytes = 10 * 1024 * 1024 * 1024, enabled = true, log = console.log } = {}) {
    this.cacheDir = cacheDir || path.join(process.cwd(), '.cache', 'assets');
    this.maxBytes = maxBytes; // 10 GB default
    this.enabled = enabled;
    this.log = log;
    this.hits = 0;
    this.misses = 0;
    this.bytesSaved = 0;

    if (this.enabled) {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    }
  }

  getFilePath(assetId) {
    return path.join(this.cacheDir, `asset_${assetId}.bin`);
  }

  getMetaPath(assetId) {
    return path.join(this.cacheDir, `asset_${assetId}.meta.json`);
  }

  has(assetId) {
    if (!this.enabled) return false;
    const file = this.getFilePath(assetId);
    const meta = this.getMetaPath(assetId);
    return fs.existsSync(file) && fs.existsSync(meta);
  }

  getMeta(assetId) {
    if (!this.has(assetId)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.getMetaPath(assetId), 'utf8'));
    } catch {
      return null;
    }
  }

  saveMeta(assetId, meta) {
    if (!this.enabled) return;
    try {
      fs.writeFileSync(this.getMetaPath(assetId), JSON.stringify(meta, null, 2));
    } catch (e) {
      this.log(`Failed to write asset metadata: ${e.message}`);
    }
  }

  /**
   * Serve a cached asset from disk with support for HTTP 206 Partial Content (Range requests)
   */
  async serveCached(assetId, req, res) {
    const filePath = this.getFilePath(assetId);
    const meta = this.getMeta(assetId) || {};
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // Update LRU / access tracking
    meta.lastAccessed = new Date().toISOString();
    meta.hitCount = (meta.hitCount || 0) + 1;
    this.saveMeta(assetId, meta);

    this.hits++;
    this.bytesSaved += fileSize;

    res.set({
      'Content-Type': meta.contentType || 'application/octet-stream',
      'Content-Disposition': meta.contentDisposition || `attachment; filename="${meta.name || `asset_${assetId}`}"`,
      'Accept-Ranges': 'bytes',
      'X-Nexus-Cache': 'HIT',
      'ETag': meta.etag || `"${assetId}-${stat.mtimeMs}"`,
    });

    const range = req.get('range');
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
        return;
      }

      const chunksize = end - start + 1;
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': String(chunksize),
      });

      const stream = fs.createReadStream(filePath, { start, end });
      await pipeline(stream, res);
    } else {
      res.status(200).set({
        'Content-Length': String(fileSize),
      });
      const stream = fs.createReadStream(filePath);
      await pipeline(stream, res);
    }
  }

  /**
   * Save an asset stream to local cache in the background
   */
  async cacheAssetStream(assetId, stream, meta) {
    if (!this.enabled) return;
    const tempPath = path.join(this.cacheDir, `asset_${assetId}.tmp.${Date.now()}`);
    const destPath = this.getFilePath(assetId);

    try {
      const writeStream = fs.createWriteStream(tempPath);
      await pipeline(stream, writeStream);

      fs.renameSync(tempPath, destPath);
      this.saveMeta(assetId, {
        ...meta,
        assetId,
        cachedAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        hitCount: 0,
        size: fs.statSync(destPath).size,
      });

      this.log(`Asset ${assetId} (${meta.name || 'unnamed'}) cached locally.`);
      this.pruneIfNeeded();
    } catch (e) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      this.log(`Failed to cache asset ${assetId}: ${e.message}`);
    }
  }

  delete(assetId) {
    const f = this.getFilePath(assetId);
    const m = this.getMetaPath(assetId);
    let deleted = false;
    if (fs.existsSync(f)) { fs.unlinkSync(f); deleted = true; }
    if (fs.existsSync(m)) { fs.unlinkSync(m); }
    return deleted;
  }

  clearAll() {
    if (!fs.existsSync(this.cacheDir)) return 0;
    const files = fs.readdirSync(this.cacheDir);
    let count = 0;
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(this.cacheDir, f));
        count++;
      } catch {}
    }
    return count;
  }

  pruneIfNeeded() {
    if (!this.enabled) return;
    try {
      const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.meta.json'));
      let totalSize = 0;
      const metas = [];

      for (const m of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(this.cacheDir, m), 'utf8'));
          totalSize += content.size || 0;
          metas.push(content);
        } catch {}
      }

      if (totalSize > this.maxBytes) {
        // Evict LRU
        metas.sort((a, b) => new Date(a.lastAccessed || 0) - new Date(b.lastAccessed || 0));
        while (totalSize > this.maxBytes && metas.length > 0) {
          const victim = metas.shift();
          this.delete(victim.assetId);
          totalSize -= victim.size || 0;
          this.log(`LRU evicted asset ${victim.assetId} (${victim.name})`);
        }
      }
    } catch (e) {
      this.log(`Error during cache pruning: ${e.message}`);
    }
  }

  getStats() {
    if (!this.enabled || !fs.existsSync(this.cacheDir)) {
      return {
        enabled: this.enabled,
        fileCount: 0,
        totalBytes: 0,
        maxBytes: this.maxBytes,
        hits: this.hits,
        misses: this.misses,
        bytesSaved: this.bytesSaved,
        items: [],
      };
    }

    try {
      const metas = fs.readdirSync(this.cacheDir)
        .filter((f) => f.endsWith('.meta.json'))
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.cacheDir, f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const totalBytes = metas.reduce((sum, m) => sum + (m.size || 0), 0);

      return {
        enabled: this.enabled,
        fileCount: metas.length,
        totalBytes,
        maxBytes: this.maxBytes,
        hits: this.hits,
        misses: this.misses,
        bytesSaved: this.bytesSaved,
        items: metas.sort((a, b) => new Date(b.cachedAt) - new Date(a.cachedAt)),
      };
    } catch (e) {
      return { enabled: this.enabled, error: e.message };
    }
  }
}
