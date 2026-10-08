#!/usr/bin/env node
'use strict';

// Runs inside the selected gateway image, with its own SQLite ABI/dependencies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

function canonical(value) {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function stableConfigDigest(config) {
  const stable = { ...config, dashboard: { ...config.dashboard } };
  delete stable.dashboard.session_secret;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(stable))).digest('hex');
}

function copyTree(source, target, exclude = []) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    if (exclude.includes(name) || (source === '/config' && /^(?:(?:activate|recover)-code\.txt|dashboard-identity\.json)\..*(?:tmp|lock)$/.test(name))) continue;
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
  let evidence = {};
  if (action === 'init') {
    // All example nodes start disabled; no real provider calls or customer data.
    const c = yaml.load(fs.readFileSync('/opt/siftgate-kit/gateway.config.example.yaml', 'utf8'));
    c.server = { ...c.server, host: '0.0.0.0', port: 2099, shutdown_timeout_ms: 30000 };
    c.database = { type: 'sqlite', path: '/app/data/gateway.db', log_retention_days: 30 };
    c.auth = { ...c.auth, api_keys: [] };
    c.nodes = c.nodes.map(({ enabled: _legacyIgnored, ...node }) => ({ ...node, disabled: true }));
    c.catalog = { ...c.catalog, override_file: '/app/.siftgate/catalog.override.yaml' };
    c.state = { backend: 'memory' };
    c.dashboard = {
      auth_required: true,
      identity_file: '/config/dashboard-identity.json',
    };
    const { DashboardIdentityStore } = require('/app/dist/auth/dashboard-identity-store.js');
    new DashboardIdentityStore(c.dashboard.identity_file).initialize();
    fs.writeFileSync('/config/gateway.config.yaml', yaml.dump(c, { lineWidth: 110 }), { flag: 'wx', mode: 0o600 });
  } else if (action === 'restore-identity') {
    const c = sqliteConfig();
    if (c.dashboard?.identity_file) {
      if (c.dashboard.identity_file !== '/config/dashboard-identity.json') throw new Error('Unsupported identity path');
      const { DashboardIdentityStore } = require('/app/dist/auth/dashboard-identity-store.js');
      new DashboardIdentityStore(c.dashboard.identity_file).revokeRestoredSessions();
      evidence.identity_mode = 'managed';
    } else {
      if (!c.dashboard || c.dashboard.auth_required === false ||
          !(typeof c.dashboard.password === 'string' && c.dashboard.password.trim() || c.dashboard.oidc?.enabled === true)) {
        throw new Error('Authenticated legacy identity required for safe recovery');
      }
      const filename = '/config/gateway.config.yaml';
      const original = fs.readFileSync(filename);
      const before = stableConfigDigest(c);
      const previous = c.dashboard.session_secret;
      // Preserve password/OIDC and every business field. A new literal secret
      // overrides the old secret/env reference or password-derived JWT fallback.
      c.dashboard.session_secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(filename, yaml.dump(c, { lineWidth: 110 }), { mode: 0o600 });
      const restored = fs.readFileSync(filename);
      const after = yaml.load(restored.toString('utf8'));
      if (stableConfigDigest(after) !== before || after.dashboard.session_secret === previous ||
          !/^[a-f0-9]{64}$/.test(after.dashboard.session_secret)) throw new Error('Restored identity reconciliation failed');
      evidence = { identity_mode: 'legacy_session_secret', only_session_secret_changed: true,
        stable_config_sha256: before,
        original_config_sha256: crypto.createHash('sha256').update(original).digest('hex'),
        restored_config_sha256: crypto.createHash('sha256').update(restored).digest('hex') };
    }
  } else if (action === 'activate-code' || action === 'recover-code') {
    const c = sqliteConfig();
    if (c.dashboard?.identity_file !== '/config/dashboard-identity.json') throw new Error('Legacy identity: use its existing recovery procedure');
    const { DashboardIdentityStore } = require('/app/dist/auth/dashboard-identity-store.js');
    new DashboardIdentityStore(c.dashboard.identity_file).issueCode(action === 'activate-code' ? 'activate' : 'recover');
  } else if (action === 'check') {
    const c = sqliteConfig();
    const { validateConfigFile } = require('/app/dist/config/config-validator.js');
    const result = validateConfigFile({ configPath: '/config/gateway.config.yaml', cwd: '/app', env: process.env });
    if (!result.ok) {
      // Only codes/paths, never resolved configuration or credentials.
      throw new Error(result.errors.map(e => `${e.code}:${e.path || ''}`).join(', '));
    }
    if (c.dashboard?.identity_file) {
      if (c.dashboard.identity_file !== '/config/dashboard-identity.json') throw new Error('Kit identity path must remain /config/dashboard-identity.json');
      const { DashboardIdentityStore } = require('/app/dist/auth/dashboard-identity-store.js');
      new DashboardIdentityStore(c.dashboard.identity_file).status();
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
    const c = sqliteConfig();
    if (c.dashboard?.identity_file) {
      if (c.dashboard.identity_file !== '/config/dashboard-identity.json') throw new Error('Kit identity path must remain /config/dashboard-identity.json');
      const { DashboardIdentityStore } = require('/app/dist/auth/dashboard-identity-store.js');
      if (new DashboardIdentityStore(c.dashboard.identity_file).status().setupRequired) throw new Error('Activate before backing up');
    }
    copyTree('/config', path.join(destination, 'config'), ['initial-admin-password.txt', 'activate-code.txt', 'recover-code.txt']);
    // Recovery tokens and old management sessions must not survive restore.
    if (c.dashboard?.identity_file) {
      const identityFile = path.join(destination, 'config/dashboard-identity.json');
      const state = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      state.access = null; state.session_secret = crypto.randomBytes(32).toString('hex'); state.revision++;
      fs.writeFileSync(identityFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    }
    copyTree('/app/.siftgate', path.join(destination, 'state'));
  } else throw new Error('Unknown operation');
  console.log(JSON.stringify({ ok: true, action, ...evidence }));
}

main().catch(() => {
  // YAML parser errors can contain source snippets with credentials.
  console.error('Customer operation failed; inspect the private configuration and filesystem locally.');
  process.exitCode = 1;
});
