#!/usr/bin/env node
'use strict';

// Runs inside the selected gateway image, with its own SQLite ABI/dependencies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

function copyTree(source, target, exclude = []) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    if (exclude.includes(name)) continue;
    const from = path.join(source, name);
    const to = path.join(target, name);
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, 0o600);
    } else throw new Error('Snapshots refuse links and special files');
  }
}

function sqliteConfig() {
  const c = yaml.load(fs.readFileSync('/config/gateway.config.yaml', 'utf8'));
  if (c.database?.type !== 'sqlite' ||
      path.resolve('/app', c.database.path) !== '/app/data/gateway.db') {
    throw new Error('Kit snapshots require SQLite at /app/data/gateway.db; use database-native tooling otherwise');
  }
  return c;
}

async function main() {
  process.umask(0o077);
  const [action, id] = process.argv.slice(2);
  if (action === 'init') {
    // All example nodes start disabled; no real provider calls or customer data.
    const c = yaml.load(fs.readFileSync('/opt/siftgate-kit/gateway.config.example.yaml', 'utf8'));
    c.server = { ...c.server, host: '0.0.0.0', port: 2099, shutdown_timeout_ms: 30000 };
    c.database = { type: 'sqlite', path: '/app/data/gateway.db', log_retention_days: 30 };
    c.auth = { ...c.auth, api_keys: [] };
    c.nodes = c.nodes.map(node => ({ ...node, enabled: false }));
    c.catalog = { ...c.catalog, override_file: '/app/.siftgate/catalog.override.yaml' };
    c.state = { backend: 'memory' };
    const password = crypto.randomBytes(24).toString('base64url');
    c.dashboard = {
      auth_required: true,
      password: require('bcryptjs').hashSync(password, 12),
      session_secret: crypto.randomBytes(48).toString('base64url'),
    };
    fs.writeFileSync('/config/gateway.config.yaml', yaml.dump(c, { lineWidth: 110 }), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync('/config/initial-admin-password.txt', password + '\n', { flag: 'wx', mode: 0o600 });
  } else if (action === 'check') {
    sqliteConfig();
    const { validateConfigFile } = require('/app/dist/config/config-validator.js');
    const result = validateConfigFile({ configPath: '/config/gateway.config.yaml', cwd: '/app', env: process.env });
    if (!result.ok) {
      // Only codes/paths, never resolved configuration or credentials.
      throw new Error(result.errors.map(e => `${e.code}:${e.path || ''}`).join(', '));
    }
  } else if (action === 'backup') {
    sqliteConfig();
    if (!/^backup-[0-9a-f-]+$/.test(id || '')) throw new Error('Invalid snapshot id');
    const destination = path.join('/backups', id);
    fs.mkdirSync(destination, { mode: 0o700 });
    const { backupSqliteDatabase } = require('/app/dist/database/sqlite-backup.js');
    fs.mkdirSync(path.join(destination, 'data'), { mode: 0o700 });
    await backupSqliteDatabase('/app/data/gateway.db', path.join(destination, 'data/gateway.db'));
    copyTree('/app/data', path.join(destination, 'data'), ['gateway.db', 'gateway.db-wal', 'gateway.db-shm']);
    copyTree('/config', path.join(destination, 'config'), ['initial-admin-password.txt']);
    copyTree('/app/.siftgate', path.join(destination, 'state'));
  } else throw new Error('Unknown operation');
  console.log(JSON.stringify({ ok: true, action }));
}

main().catch(() => {
  // YAML parser errors can contain source snippets with credentials.
  console.error('Customer operation failed; inspect the private configuration and filesystem locally.');
  process.exitCode = 1;
});
