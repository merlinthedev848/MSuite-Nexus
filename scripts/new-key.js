#!/usr/bin/env node
// Usage: node scripts/new-key.js <client-name> <owner/repo|owner/*> [...more repos] [--perms releases,raw,archive] [--ips 10.0.0.0/8] [--expires 2027-01-01] [--desc "Description"] [--file clients.json]
import fs from 'node:fs';
import path from 'node:path';
import { generateKey, hashKey, parseClients, PERMISSIONS } from '../src/clients.js';

const args = process.argv.slice(2);
let file = process.env.CLIENTS_FILE || './clients.json';
let perms = PERMISSIONS;
let allowedIps = ['*'];
let expiresAt = null;
let description = '';
let rateLimit = null;
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') file = args[++i];
  else if (args[i] === '--perms') perms = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (args[i] === '--ips') allowedIps = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (args[i] === '--rate-limit') rateLimit = parseInt(args[++i], 10);
  else if (args[i] === '--expires') {
    const rawExp = args[++i];
    const expTime = new Date(rawExp).getTime();
    if (isNaN(expTime)) {
      console.error(`Error: Invalid date format for --expires "${rawExp}". Use ISO format e.g. YYYY-MM-DD.`);
      process.exit(1);
    }
    expiresAt = new Date(expTime).toISOString();
  }
  else if (args[i] === '--desc') description = args[++i];
  else positional.push(args[i]);
}

const [name, ...repos] = positional;
if (!name || repos.length === 0) {
  console.error('Usage: node scripts/new-key.js <client-name> <owner/repo|owner/*> [...] [--perms releases,raw,archive] [--ips 10.0.0.0/8] [--expires 2027-01-01] [--desc "Description"] [--file clients.json]');
  process.exit(1);
}

let data = { clients: [] };
if (fs.existsSync(file)) {
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${file}: ${e.message}`);
    process.exit(1);
  }
}
data.clients ??= [];

if (data.clients.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
  console.error(`Client "${name}" already exists in ${file}. Remove it first to rotate its key.`);
  process.exit(1);
}

const key = generateKey();
data.clients.push({
  name,
  description,
  keyHash: hashKey(key),
  repos,
  permissions: perms,
  allowedIps,
  expiresAt,
  rateLimit: Number.isFinite(rateLimit) && rateLimit >= 0 ? rateLimit : undefined,
  createdAt: new Date().toISOString(),
});

parseClients(data); // validate before writing

const dir = path.dirname(file);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const tmp = `${file}.tmp.${Date.now()}`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
fs.renameSync(tmp, file);

console.log(`Added client "${name}" to ${file}`);
console.log(`Repos:       ${repos.join(', ')}`);
console.log(`Permissions: ${perms.join(', ')}`);
console.log(`Allowed IPs: ${allowedIps.join(', ')}`);
console.log(`Expires:     ${expiresAt || 'Never'}`);
console.log('\nAPI key (shown once, store it securely):\n');
console.log(key);
