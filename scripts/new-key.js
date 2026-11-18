#!/usr/bin/env node
// Usage: node scripts/new-key.js <client-name> <owner/repo|owner/*> [...more repos] [--perms releases,raw,archive] [--file clients.json]
import fs from 'node:fs';
import { generateKey, hashKey, parseClients, PERMISSIONS } from '../src/clients.js';

const args = process.argv.slice(2);
let file = process.env.CLIENTS_FILE || './clients.json';
let perms = PERMISSIONS;
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') file = args[++i];
  else if (args[i] === '--perms') perms = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else positional.push(args[i]);
}

const [name, ...repos] = positional;
if (!name || repos.length === 0) {
  console.error('Usage: node scripts/new-key.js <client-name> <owner/repo|owner/*> [...] [--perms releases,raw,archive] [--file clients.json]');
  process.exit(1);
}

let data = { clients: [] };
if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.clients ??= [];

if (data.clients.some((c) => c.name === name)) {
  console.error(`Client "${name}" already exists in ${file}. Remove it first to rotate its key.`);
  process.exit(1);
}

const key = generateKey();
data.clients.push({ name, keyHash: hashKey(key), repos, permissions: perms });
parseClients(data); // validate before writing
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

console.log(`Added client "${name}" to ${file}`);
console.log(`Repos: ${repos.join(', ')}  Permissions: ${perms.join(', ')}`);
console.log('\nAPI key (shown once, store it securely):\n');
console.log(key);
