export class MetricsCollector {
  constructor({ maxLogHistory = 150 } = {}) {
    this.maxLogHistory = maxLogHistory;
    this.startTime = Date.now();
    this.totalRequests = 0;
    this.statusCodes = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    this.bytesStreamed = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.latencies = []; // last 100 request latencies in ms
    this.clientStats = new Map(); // clientName -> { requests, bytes, lastSeen }
    this.recentLogs = []; // ring buffer of recent requests
  }

  recordRequest({ client, ip, method, path, status, ms, bytes = 0, error = null }) {
    this.totalRequests++;

    const category = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
    this.statusCodes[category] = (this.statusCodes[category] || 0) + 1;

    this.bytesStreamed += bytes;

    this.latencies.push(ms);
    if (this.latencies.length > 200) this.latencies.shift();

    const clientName = client || 'anonymous';
    const cStat = this.clientStats.get(clientName) || { requests: 0, bytes: 0, lastSeen: null };
    cStat.requests++;
    cStat.bytes += bytes;
    cStat.lastSeen = new Date().toISOString();
    this.clientStats.set(clientName, cStat);

    const logEntry = {
      id: Math.random().toString(36).substring(2, 9),
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

  getSnapshot(githubRateLimits = null) {
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
      latency: {
        avgMs: avgLatency,
        p95Ms: p95Latency,
      },
      clients,
      githubRateLimits,
      memory: process.memoryUsage(),
    };
  }

  getRecentLogs() {
    return [...this.recentLogs].reverse();
  }
}
