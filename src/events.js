import { EventEmitter } from 'node:events';

export class EventBroker extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }

  addClient(res) {
    this.clients.add(res);
    const cleanup = () => {
      this.clients.delete(res);
    };
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
  }

  broadcast(eventType, data) {
    if (this.clients.size === 0) return;
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        if (!res.writableEnded && !res.destroyed) {
          res.write(payload);
        } else {
          this.clients.delete(res);
        }
      } catch {
        this.clients.delete(res);
      }
    }
  }

  get connectedCount() {
    return this.clients.size;
  }
}
