import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/**
 * MSuite Nexus Real-Time Message Bus & Data Transport
 * 
 * Provides high-speed inter-product messaging, pub/sub telemetry routing,
 * and security event dispatch across all connected MSuite applications.
 */
export class MessageBus extends EventEmitter {
  constructor({ maxHistory = 500 } = {}) {
    super();
    this.maxHistory = maxHistory;
    this.history = [];
    this.subscribers = new Set(); // Set of { res, topics: string[], clientName: string }
  }

  topicMatches(filter, topic) {
    if (filter === '*' || filter === topic) return true;
    if (filter.endsWith('.*')) {
      const prefix = filter.slice(0, -2);
      return topic.startsWith(prefix);
    }
    return false;
  }

  publish({ topic, sender = 'anonymous', payload = {} }) {
    if (!topic || typeof topic !== 'string') throw new Error('Message topic is required');

    const message = {
      id: randomUUID(),
      topic: topic.trim().toLowerCase(),
      sender,
      timestamp: new Date().toISOString(),
      payload,
    };

    this.history.push(message);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const wirePayload = `event: message\ndata: ${JSON.stringify(message)}\n\n`;

    for (const sub of this.subscribers) {
      const matches = sub.topics.some((t) => this.topicMatches(t, message.topic));
      if (matches) {
        try {
          if (!sub.res.writableEnded && !sub.res.destroyed) {
            sub.res.write(wirePayload);
          } else {
            this.subscribers.delete(sub);
          }
        } catch {
          this.subscribers.delete(sub);
        }
      }
    }

    this.emit('message', message);
    return message;
  }

  addSubscriber(res, topics = ['*'], clientName = 'anonymous') {
    const cleanTopics = (Array.isArray(topics) ? topics : [topics])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);

    const sub = {
      res,
      topics: cleanTopics.length ? cleanTopics : ['*'],
      clientName,
    };

    this.subscribers.add(sub);

    const cleanup = () => {
      this.subscribers.delete(sub);
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);

    // Initial greeting
    res.write(`event: subscribed\ndata: ${JSON.stringify({ time: new Date().toISOString(), topics: sub.topics })}\n\n`);

    return sub;
  }

  getRecentMessages({ topic = null, limit = 50 } = {}) {
    let list = [...this.history].reverse();
    if (topic) {
      const target = topic.toLowerCase().trim();
      list = list.filter((m) => this.topicMatches(target, m.topic));
    }
    return list.slice(0, limit);
  }

  get stats() {
    return {
      activeSubscribers: this.subscribers.size,
      totalMessagesInHistory: this.history.length,
      topics: Array.from(new Set(this.history.map((m) => m.topic))),
    };
  }
}
