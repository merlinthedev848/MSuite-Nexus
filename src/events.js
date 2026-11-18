import { EventEmitter } from 'node:events';

export class EventBroker extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }

  addClient(res) {
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  broadcast(eventType, data) {
    if (this.clients.size === 0) return;
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  get connectedCount() {
    return this.clients.size;
  }
}
