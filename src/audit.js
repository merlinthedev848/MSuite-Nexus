import fs from 'node:fs';
import path from 'node:path';

export class AuditLogger {
  constructor({ logFile, maxEntries = 1000 } = {}) {
    this.logFile = logFile || path.join(process.cwd(), '.cache', 'audit.jsonl');
    this.maxEntries = maxEntries;
    this.inMemory = [];

    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.loadInitial();
  }

  loadInitial() {
    if (!fs.existsSync(this.logFile)) return;
    try {
      const lines = fs.readFileSync(this.logFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      const recent = lines.slice(-this.maxEntries);
      this.inMemory = recent.map((l) => JSON.parse(l));
    } catch {}
  }

  record({ actor = 'admin', ip, action, target, details = {} }) {
    const entry = {
      id: Math.random().toString(36).substring(2, 10),
      timestamp: new Date().toISOString(),
      actor,
      ip: ip || 'internal',
      action,
      target,
      details,
    };

    this.inMemory.push(entry);
    if (this.inMemory.length > this.maxEntries) {
      this.inMemory.shift();
    }

    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch {}

    return entry;
  }

  getEntries({ limit = 100, action = null } = {}) {
    let list = [...this.inMemory].reverse();
    if (action) {
      list = list.filter((e) => e.action.toLowerCase() === action.toLowerCase());
    }
    return list.slice(0, limit);
  }
}
