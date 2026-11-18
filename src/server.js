import { loadConfig } from './config.js';
import { ClientStore } from './clients.js';
import { GitHub } from './github.js';
import { createApp } from './app.js';

const log = (msg) => console.log(msg);

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`Config error: ${e.message}`);
  process.exit(1);
}

const clients = new ClientStore(config.clientsFile);
try {
  log(`loaded ${clients.load()} active clients from ${config.clientsFile}`);
} catch (e) {
  console.error(`Failed to load clients file ${config.clientsFile}: ${e.message}`);
  process.exit(1);
}
clients.watch(log);

const github = new GitHub({
  token: config.githubToken,
  apiUrl: config.githubApiUrl,
  cacheTtlMs: config.cacheTtlMs,
  cacheMaxEntries: config.cacheMaxEntries,
});

const app = createApp({ config, clients, github, log });
const server = app.listen(config.port, config.host, () => {
  log(`MSuite CodeHandler listening on http://${config.host}:${config.port}`);
});

const shutdown = (sig) => {
  log(`${sig} received, shutting down`);
  clients.unwatch();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
