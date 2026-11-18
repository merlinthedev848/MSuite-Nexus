import { createHmac, timingSafeEqual } from 'node:crypto';

export function createWebhookHandler({ github, events, secret, log = console.log }) {
  return async (req, res) => {
    const signature = req.get('x-hub-signature-256') || '';
    const event = req.get('x-github-event') || 'ping';

    // Verify HMAC signature if secret is configured
    if (secret) {
      if (!signature.startsWith('sha256=')) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing X-Hub-Signature-256' });
      }
      const rawBody = req.rawBody || JSON.stringify(req.body);
      const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return res.status(401).json({ error: 'unauthorized', message: 'Invalid webhook signature' });
      }
    }

    const payload = req.body || {};
    const repo = payload.repository?.full_name;

    log(`GitHub webhook received: event=${event}, action=${payload.action}, repo=${repo || 'unknown'}`);

    if (event === 'ping') {
      return res.json({ ok: true, message: 'pong' });
    }

    let purgedCount = 0;
    if (repo) {
      purgedCount = github.clearCache(repo);
    }

    events?.broadcast('webhook', {
      event,
      action: payload.action,
      repository: repo,
      purgedEntries: purgedCount,
      time: new Date().toISOString(),
    });

    res.json({
      ok: true,
      event,
      action: payload.action,
      repository: repo,
      purgedEntries: purgedCount,
    });
  };
}
