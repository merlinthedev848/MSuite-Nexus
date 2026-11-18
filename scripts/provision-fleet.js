#!/usr/bin/env node
/**
 * MSuite Fleet Auto-Provisioning Script
 * 
 * Automatically provisions API keys for all MSuite products (SIP, Sentinel, HoneyPot, etc.)
 * or generates a Universal Fleet Master Key for all repositories under your GitHub organization.
 * 
 * Usage:
 *   node scripts/provision-fleet.js [--org merlinthedev848] [--file clients.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateKey, hashKey, parseClients, PERMISSIONS } from '../src/clients.js';

const args = process.argv.slice(2);
let file = process.env.CLIENTS_FILE || './clients.json';
let org = 'merlinthedev848';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') file = args[++i];
  else if (args[i] === '--org') org = args[++i];
}

const PRODUCTS = [
  { name: 'msuite-fleet-universal', desc: 'Universal Master Key for all MSuite Products', repos: [`${org}/*`], perms: PERMISSIONS },
  { name: 'msuite-sip', desc: 'MSuite SIP Desktop & VoIP Client', repos: [`${org}/MSuite-SIP`], perms: ['releases', 'raw'] },
  { name: 'msuite-sentinel', desc: 'MSuite Sentinel Security Agent', repos: [`${org}/MSuite-Sentinel`], perms: ['releases', 'raw'] },
  { name: 'msuite-honeypot', desc: 'MSuite HoneyPot Threat Sensor', repos: [`${org}/MSuite-HoneyPot`], perms: ['releases', 'raw'] },
  { name: 'msuite-mstream', desc: 'MSuite Media & Streaming Core', repos: [`${org}/MStream`], perms: ['releases', 'raw', 'archive'] },
  { name: 'msuite-nexus', desc: 'MSuite Nexus Central Gateway & Core Engine', repos: [`${org}/MSuite-Nexus`], perms: ['releases', 'raw', 'archive', 'services', 'bus:publish', 'bus:subscribe'] },
];

let data = { clients: [] };
if (fs.existsSync(file)) {
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
}
data.clients ??= [];

const results = [];
let envConfig = `# MSuite Products Unified Nexus Configuration\n# Generated: ${new Date().toISOString()}\nMSUITE_NEXUS_URL=http://localhost:8080\n\n`;

for (const prod of PRODUCTS) {
  let existing = data.clients.find((c) => c.name.toLowerCase() === prod.name.toLowerCase());
  let key;

  if (existing) {
    key = '(Existing key retained - rotate in Web UI or delete to re-issue)';
  } else {
    key = generateKey();
    const clientEntry = {
      name: prod.name,
      description: prod.desc,
      keyHash: hashKey(key),
      repos: prod.repos,
      permissions: prod.perms,
      allowedIps: ['*'],
      expiresAt: null,
      createdAt: new Date().toISOString(),
    };
    data.clients.push(clientEntry);
    results.push({ name: prod.name, key, repos: prod.repos });
  }

  const envVar = prod.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
  envConfig += `# ${prod.desc}\n${envVar}=${key}\n`;
}

parseClients(data); // Validate

const dir = path.dirname(file);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const tmp = `${file}.tmp.${Date.now()}`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
fs.renameSync(tmp, file);

// Save generated .env template
const envPath = path.join(process.cwd(), '.env.msuite.example');
fs.writeFileSync(envPath, envConfig);

console.log('================================================================');
console.log('🌌 MSuite Fleet Provisioning Complete');
console.log('================================================================');
console.log(`Updated client database: ${file}`);
console.log(`Generated env template:  ${envPath}\n`);

console.log('Newly Provisioned MSuite Client Keys:');
console.log('----------------------------------------------------------------');
for (const r of results) {
  console.log(`App:   ${r.name}`);
  console.log(`Repos: ${r.repos.join(', ')}`);
  console.log(`Key:   ${r.key}\n`);
}

console.log('To connect any MSuite app, set these two environment variables:');
console.log('  MSUITE_NEXUS_URL=http://<your-nexus-host>:8080');
console.log('  MSUITE_NEXUS_KEY=<app-api-key>');
console.log('================================================================');
