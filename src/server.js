import { loadConfig } from './config.js';
import { ClientStore } from './clients.js';
import { GitHub } from './github.js';
import { MetricsCollector } from './metrics.js';
import { EventBroker } from './events.js';
import { AssetCache } from './asset-cache.js';
import { AuditLogger } from './audit.js';
import { ServiceGateway } from './gateway.js';
import { MessageBus } from './bus.js';
import { createApp } from './app.js';

const log = (msg) => console.log(msg);

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`Config error: ${e.message}`);
  process.exit(1);
}

const clients = new ClientStore(config.clientsFile);
try {
  log(`Loaded ${clients.load()} active clients from ${config.clientsFile}`);
} catch (e) {
  console.error(`Failed to load clients file ${config.clientsFile}: ${e.message}`);
  process.exit(1);
}
clients.watch(log);

const metrics = new MetricsCollector();
const events = new EventBroker();
const bus = new MessageBus();
const gateway = new ServiceGateway({ log });
const audit = new AuditLogger({ logFile: config.auditLogFile });
const assetCache = new AssetCache({
  cacheDir: config.assetCacheDir,
  maxBytes: config.assetCacheMaxBytes,
  enabled: config.assetCacheEnabled,
  log,
});

const github = new GitHub({
  tokens: config.githubTokens,
  apiUrl: config.githubApiUrl,
  cacheTtlMs: config.cacheTtlMs,
  cacheMaxEntries: config.cacheMaxEntries,
  metrics,
});

const app = createApp({
  config,
  clients,
  github,
  metrics,
  events,
  assetCache,
  audit,
  gateway,
  bus,
  log,
});

const server = app.listen(config.port, config.host, () => {
  log(`====================================================`);
  log(`  MSuite Nexus 2.0 (GitHub Private Proxy & Hub)     `);
  log(`====================================================`);
  log(`  Proxy API:    http://${config.host}:${config.port}/v1`);
  log(`  Web UI:       http://${config.host}:${config.port}/`);
  log(`  Prometheus:   http://${config.host}:${config.port}/metrics`);
  log(`  Asset Cache:  ${config.assetCacheEnabled ? 'Enabled (' + Math.round(config.assetCacheMaxBytes / (1024 * 1024 * 1024)) + 'GB)' : 'Disabled'}`);
  log(`  Admin Token:  ${config.adminToken}`);
  if (config.adminTokenGenerated) {
    log(`  [NOTE] Admin token was randomly generated for this session.`);
    log(`         Set ADMIN_TOKEN in .env to persist your credentials.`);
  }
  log(`====================================================`);
});

server.on('error', (err) => {
  console.error(`Fatal Server Error: ${err.message}`);
  process.exit(1);
});

const shutdown = (sig) => {
  log(`${sig} received, shutting down gracefully...`);
  clients.unwatch();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
