import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class AuditLogger {
  constructor({ logFile, maxEntries = 1000 } = {}) {
    this.logFile = logFile || path.join(process.cwd(), '.cache', 'audit.jsonl');
    this.maxEntries = maxEntries;
    this.inMemory = [];

    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
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
      const parsed = [];
      for (const line of recent) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          // Skip corrupted single line without invalidating whole log
        }
      }
      this.inMemory = parsed;
    } catch {}
  }

  record({ actor = 'admin', ip, action, target, details = {} }) {
    const entry = {
      id: randomUUID(),
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
