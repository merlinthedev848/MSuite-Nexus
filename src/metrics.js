import { randomUUID } from 'node:crypto';

export class MetricsCollector {
  constructor({ maxLogHistory = 150 } = {}) {
    this.maxLogHistory = maxLogHistory;
    this.startTime = Date.now();
    this.totalRequests = 0;
    this.statusCodes = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    this.bytesStreamed = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.latencies = []; // last 200 request latencies in ms
    this.clientStats = new Map(); // clientName -> { requests, bytes, lastSeen }
    this.recentLogs = []; // ring buffer of recent requests
    this.minuteBuckets = new Map(); // minuteTimestamp -> requestCount
  }

  recordRequest({ client, ip, method, path, status, ms, bytes = 0, error = null }) {
    this.totalRequests++;

    const category = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
    this.statusCodes[category] = (this.statusCodes[category] || 0) + 1;

    this.bytesStreamed += bytes;

    this.latencies.push(ms);
    if (this.latencies.length > 200) this.latencies.shift();

    // Rolling minute throughput buckets
    const minute = Math.floor(Date.now() / 60000) * 60;
    this.minuteBuckets.set(minute, (this.minuteBuckets.get(minute) || 0) + 1);
    // Keep only last 30 minutes
    if (this.minuteBuckets.size > 30) {
      const keys = Array.from(this.minuteBuckets.keys());
      if (keys.length > 0) {
        const oldest = Math.min(...keys);
        this.minuteBuckets.delete(oldest);
      }
    }

    const clientName = client || 'anonymous';
    const cStat = this.clientStats.get(clientName) || { requests: 0, bytes: 0, lastSeen: null };
    cStat.requests++;
    cStat.bytes += bytes;
    cStat.lastSeen = new Date().toISOString();
    this.clientStats.set(clientName, cStat);

    const logEntry = {
      id: randomUUID(),
      time: new Date().toISOString(),
      client: clientName,
      ip,
      method,
      path,
      status,
      ms,
      bytes,
      error,
    };

    this.recentLogs.push(logEntry);
    if (this.recentLogs.length > this.maxLogHistory) {
      this.recentLogs.shift();
    }

    return logEntry;
  }

  recordCacheHit() {
    this.cacheHits++;
  }

  recordCacheMiss() {
    this.cacheMisses++;
  }

  getThroughputHistory() {
    const currentMinute = Math.floor(Date.now() / 60000) * 60;
    const history = [];
    for (let i = 14; i >= 0; i--) {
      const m = currentMinute - i * 60;
      history.push({
        minute: m,
        time: new Date(m * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        count: this.minuteBuckets.get(m) || 0,
      });
    }
    return history;
  }

  getSnapshot(githubRateLimits = null, assetCacheStats = null) {
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
    const avgLatency = this.latencies.length
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
      : 0;

    const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
    const p95Latency = sortedLatencies.length
      ? sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || sortedLatencies[sortedLatencies.length - 1]
      : 0;

    const totalCacheOps = this.cacheHits + this.cacheMisses;
    const hitRatePercent = totalCacheOps ? Math.round((this.cacheHits / totalCacheOps) * 100) : 100;

    const clients = [];
    for (const [name, stat] of this.clientStats.entries()) {
      clients.push({ name, ...stat });
    }

    return {
      uptimeSec,
      totalRequests: this.totalRequests,
      statusCodes: { ...this.statusCodes },
      bytesStreamed: this.bytesStreamed,
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRatePercent,
      },
      assetCache: assetCacheStats,
      latency: {
        avgMs: avgLatency,
        p95Ms: p95Latency,
      },
      throughput: this.getThroughputHistory(),
      clients,
      githubRateLimits,
      memory: process.memoryUsage(),
    };
  }

  getRecentLogs() {
    return [...this.recentLogs].reverse();
  }

  toPrometheusText(githubRateLimits = null, assetCacheStats = null) {
    const lines = [
      '# HELP nexus_requests_total Total number of HTTP requests processed by MSuite Nexus',
      '# TYPE nexus_requests_total counter',
      `nexus_requests_total{status="2xx"} ${this.statusCodes['2xx'] || 0}`,
      `nexus_requests_total{status="3xx"} ${this.statusCodes['3xx'] || 0}`,
      `nexus_requests_total{status="4xx"} ${this.statusCodes['4xx'] || 0}`,
      `nexus_requests_total{status="5xx"} ${this.statusCodes['5xx'] || 0}`,
      '',
      '# HELP nexus_bytes_streamed_total Total bytes delivered to clients',
      '# TYPE nexus_bytes_streamed_total counter',
      `nexus_bytes_streamed_total ${this.bytesStreamed}`,
      '',
      '# HELP nexus_cache_hits_total Total API memory cache hits',
      '# TYPE nexus_cache_hits_total counter',
      `nexus_cache_hits_total ${this.cacheHits}`,
      '',
      '# HELP nexus_cache_misses_total Total API memory cache misses',
      '# TYPE nexus_cache_misses_total counter',
      `nexus_cache_misses_total ${this.cacheMisses}`,
      '',
      '# HELP nexus_uptime_seconds Process uptime in seconds',
      '# TYPE nexus_uptime_seconds gauge',
      `nexus_uptime_seconds ${Math.floor((Date.now() - this.startTime) / 1000)}`,
    ];

    if (assetCacheStats) {
      lines.push(
        '',
        '# HELP nexus_asset_cache_bytes_saved_total Total bytes served from local disk cache instead of upstream',
        '# TYPE nexus_asset_cache_bytes_saved_total counter',
        `nexus_asset_cache_bytes_saved_total ${assetCacheStats.bytesSaved || 0}`,
        '',
        '# HELP nexus_asset_cache_disk_bytes Current disk space used by cached release assets',
        '# TYPE nexus_asset_cache_disk_bytes gauge',
        `nexus_asset_cache_disk_bytes ${assetCacheStats.totalBytes || 0}`,
        '',
        '# HELP nexus_asset_cache_items Current number of cached release binaries on disk',
        '# TYPE nexus_asset_cache_items gauge',
        `nexus_asset_cache_items ${assetCacheStats.fileCount || 0}`
      );
    }

    if (githubRateLimits?.current?.remaining !== undefined) {
      lines.push(
        '',
        '# HELP nexus_github_ratelimit_remaining Remaining GitHub API requests on active token',
        '# TYPE nexus_github_ratelimit_remaining gauge',
        `nexus_github_ratelimit_remaining ${githubRateLimits.current.remaining}`
      );
    }

    return lines.join('\n') + '\n';
  }
}
