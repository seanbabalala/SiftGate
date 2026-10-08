#!/usr/bin/env node
'use strict';

// Standalone: copy this file OUTSIDE Desktop/Documents/Downloads on macOS.
// No provider credentials, app dependencies, database writes, or shell execution.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { sendAlert, validateChannel } = require('./lib/alert-connectors');

function validateConfig(input) {
  const c = {
    enabled: false, allowRestart: false, timeoutMs: 5000, failureThreshold: 2,
    restartCooldownMs: 120000, restartWindowMs: 900000, maxRestarts: 3,
    startupGraceMs: 15000, alertCooldownMs: 300000, logMaxBytes: 1048576,
    minFreeBytes: 0, maxDatabaseBytes: 0, ...input,
  };
  for (const key of ['enabled', 'allowRestart']) {
    if (typeof c[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  }
  for (const key of ['stateDirectory', 'maintenanceFile']) {
    if (typeof c[key] !== 'string' || !path.isAbsolute(c[key])) throw new Error(`${key} must be absolute`);
  }
  for (const key of ['dataDirectory', 'databasePath', 'webhookUrlFile', 'alertChannelsFile']) {
    if (c[key] && !path.isAbsolute(c[key])) throw new Error(`${key} must be absolute`);
  }
  if (!['launchd', 'systemd'].includes(c.manager)) throw new Error('Unknown service manager');
  if (typeof c.service !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(c.service)) throw new Error('Invalid service name');
  const url = new URL(c.healthUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/live' || url.search || url.hash) {
    throw new Error('healthUrl must be a credential-free loopback HTTP /live URL');
  }
  for (const key of ['timeoutMs', 'failureThreshold', 'restartCooldownMs', 'restartWindowMs',
    'maxRestarts', 'startupGraceMs', 'alertCooldownMs', 'logMaxBytes']) {
    if (!Number.isSafeInteger(c[key]) || c[key] < 1) throw new Error(`Invalid ${key}`);
  }
  if (c.timeoutMs > 30000 || c.startupGraceMs > 120000 || c.restartWindowMs < c.restartCooldownMs) {
    throw new Error('Invalid watchdog time bounds');
  }
  for (const key of ['minFreeBytes', 'maxDatabaseBytes']) {
    if (!Number.isSafeInteger(c[key]) || c[key] < 0) throw new Error(`Invalid ${key}`);
  }
  return c;
}

async function probe(c) {
  try {
    const response = await fetch(c.healthUrl, { signal: AbortSignal.timeout(c.timeoutMs), redirect: 'error' });
    return response.status === 200 && (await response.json()).status === 'alive';
  } catch { return false; }
}

async function restart(c) {
  if (c.manager === 'launchd') {
    if (process.platform !== 'darwin') throw new Error('launchd requires macOS');
    await execute('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${c.service}`],
      { timeout: 15000, maxBuffer: 16384 });
  } else {
    if (process.platform !== 'linux') throw new Error('systemd requires Linux');
    await execute('/usr/bin/systemctl', ['--no-ask-password', 'restart', c.service],
      { timeout: 15000, maxBuffer: 16384 });
  }
}

async function notify(c, event, state = { alerts: {} }) {
  if (c.alertChannelsFile) {
    const stat = fs.lstatSync(c.alertChannelsFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 262144) throw new Error('Connector snapshot must be a bounded private file');
    const snapshot = JSON.parse(fs.readFileSync(c.alertChannelsFile, 'utf8'));
    if (snapshot.format !== 'siftgate-alert-connectors-v1' || typeof snapshot.enabled !== 'boolean' ||
        !Array.isArray(snapshot.channels) || snapshot.channels.length > 20) throw new Error('Invalid connector snapshot');
    if (!snapshot.enabled) return true;
    snapshot.channels.forEach((channel) => validateChannel(channel));
    const transition = ['gateway_recovered', 'gateway_restart_attempt', 'gateway_restart_failed', 'gateway_restart_unhealthy'].includes(event.event);
    const results = await Promise.all(snapshot.channels.map(async (channel, index) => {
      if (channel.enabled === false || (channel.events?.length && !channel.events.includes(event.event))) return true;
      const key = `connector:${channel.id || index}:${event.event}`;
      const now = Date.now();
      if (!transition && state.alerts[key] !== undefined && now - state.alerts[key] < (channel.debounce_seconds ?? 300) * 1000) return true;
      try {
        await sendAlert(channel, { version: 'siftgate.alert.v1', ...event,
          severity: event.event === 'gateway_recovered' ? 'info' :
            ['gateway_unavailable', 'gateway_restart_failed', 'gateway_restart_unhealthy', 'restart_rate_limited'].includes(event.event) ? 'critical' : 'warning',
          message: `${event.service}: ${event.event}` }, { timeoutMs: Math.min(c.timeoutMs, 5000) });
        state.alerts[key] = now;
        return true;
      } catch { return false; }
    }));
    return results.every(Boolean);
  }
  if (!c.webhookUrlFile) return false;
  const stat = fs.lstatSync(c.webhookUrlFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Webhook URL file must be private');
  const url = new URL(fs.readFileSync(c.webhookUrlFile, 'utf8').trim());
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Webhook requires HTTPS');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
  });
  await response.body?.cancel();
  return response.ok;
}

function appendLog(c, event) {
  const file = path.join(c.stateDirectory, 'watchdog.log');
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile()) throw new Error('Watchdog log must be a regular file');
    if (fs.statSync(file).size >= c.logMaxBytes) {
      for (let i = 3; i >= 1; i--) {
        const previous = i === 1 ? file : `${file}.${i - 1}`;
        if (fs.existsSync(previous)) fs.renameSync(previous, `${file}.${i}`);
      }
    }
  }
  fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
}

function acquireLock(directory) {
  const lock = path.join(directory, 'watchdog.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.lstatSync(lock).isDirectory()) throw new Error('Invalid watchdog lock');
    // Never evict an active process, or an incompletely-created lock.
    const ownerFile = path.join(lock, 'pid');
    if (!fs.existsSync(ownerFile)) {
      if (Date.now() - fs.statSync(lock).mtimeMs < 60000) return null;
      try { fs.rmdirSync(lock); } catch { return null; }
      return acquireLock(directory);
    }
    const pid = Number(fs.readFileSync(ownerFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid lock owner');
    try { process.kill(pid, 0); return null; } catch (e) {
      if (e.code !== 'ESRCH') return null;
    }
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(lock);
    return acquireLock(directory);
  }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => { fs.unlinkSync(path.join(lock, 'pid')); fs.rmdirSync(lock); };
}

async function runOnce(input, dependencies = {}) {
  const c = validateConfig(input);
  if (!c.enabled) return { status: 'disabled' };
  const deps = { probe, restart, notify, now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ...dependencies };
  fs.mkdirSync(c.stateDirectory, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(c.stateDirectory);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0) throw new Error('State directory must be private');
  const unlock = acquireLock(c.stateDirectory);
  if (!unlock) return { status: 'locked' };
  try {
    const statePath = path.join(c.stateDirectory, 'state.json');
    const state = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
      : { failures: 0, restarts: [], alerts: {}, incident: false };
    if (!Number.isSafeInteger(state.failures) || state.failures < 0 || !Array.isArray(state.restarts) ||
        !state.restarts.every(Number.isFinite) || typeof state.incident !== 'boolean' ||
        !state.alerts || typeof state.alerts !== 'object' || Array.isArray(state.alerts) ||
        !Object.values(state.alerts).every(Number.isFinite)) {
      throw new Error('Invalid watchdog state; restart suppressed');
    }
    const save = () => {
      const temporary = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, statePath);
    };
    const event = async (name, details = {}) => {
      const entry = { event: name, service: c.service, timestamp: new Date(deps.now()).toISOString(), ...details };
      appendLog(c, entry);
      const lastSent = state.alerts[name];
      const transition = ['gateway_recovered', 'gateway_restart_attempt', 'gateway_restart_failed', 'gateway_restart_unhealthy'].includes(name);
      if (!c.alertChannelsFile && !transition && lastSent !== undefined && deps.now() - lastSent < c.alertCooldownMs) return;
      try {
        if (await deps.notify(c, entry, state)) state.alerts[name] = deps.now();
        else if (c.webhookUrlFile || c.alertChannelsFile) appendLog(c, { event: 'alert_delivery_failed', timestamp: entry.timestamp });
      } catch {
        appendLog(c, { event: 'alert_delivery_failed', timestamp: entry.timestamp });
      }
    };
    if (fs.existsSync(c.maintenanceFile)) return { status: 'maintenance' };
    if (c.dataDirectory && c.minFreeBytes) {
      try {
        const disk = fs.statfsSync(c.dataDirectory);
        const freeBytes = disk.bavail * disk.bsize;
        if (freeBytes < c.minFreeBytes) await event('disk_space_low', { free_bytes: freeBytes });
      } catch { await event('disk_check_failed'); }
    }
    if (c.databasePath && c.maxDatabaseBytes) {
      try {
        const mainBytes = fs.statSync(c.databasePath).size;
        let walBytes = 0;
        try { walBytes = fs.statSync(`${c.databasePath}-wal`).size; } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const bytes = mainBytes + walBytes;
        if (bytes >= c.maxDatabaseBytes) await event('database_size_high', { bytes, wal_bytes: walBytes });
      } catch { await event('database_size_check_failed'); }
    }
    if (await deps.probe(c)) {
      if (state.incident) await event('gateway_recovered');
      state.failures = 0;
      state.incident = false;
      save();
      return { status: 'healthy' };
    }
    state.failures = Math.min(state.failures + 1, 100000);
    if (state.failures < c.failureThreshold) {
      appendLog(c, { event: 'probe_failed', failures: state.failures, timestamp: new Date(deps.now()).toISOString() });
      save();
      return { status: 'waiting' };
    }
    state.incident = true;
    await event('gateway_unavailable', { failures: state.failures });
    state.restarts = state.restarts.filter((time) => deps.now() - time < c.restartWindowMs);
    save();
    if (!c.allowRestart || fs.existsSync(c.maintenanceFile)) return { status: 'restart_suppressed' };
    if (state.restarts.length >= c.maxRestarts ||
        state.restarts.some((time) => deps.now() - time < c.restartCooldownMs)) {
      await event('restart_rate_limited');
      save();
      return { status: 'rate_limited' };
    }
    // Persist the attempt before executing it: crashes must not reset the limit.
    state.restarts.push(deps.now());
    state.failures = 0;
    save();
    await event('gateway_restart_attempt');
    try {
      if (fs.existsSync(c.maintenanceFile)) return { status: 'maintenance' };
      await deps.restart(c);
      await deps.sleep(c.startupGraceMs);
      const healthy = await deps.probe(c);
      await event(healthy ? 'gateway_recovered' : 'gateway_restart_unhealthy');
      state.incident = !healthy;
      save();
      return { status: healthy ? 'restarted' : 'restart_unhealthy' };
    } catch {
      await event('gateway_restart_failed');
      save();
      return { status: 'restart_failed' };
    }
  } finally { unlock(); }
}

if (require.main === module) {
  const [, , configPath, check] = process.argv;
  Promise.resolve().then(() => {
    if (!configPath || (check && check !== '--check')) throw new Error('Usage: gateway-watchdog.js <config.json> [--check]');
    const c = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    return check ? { status: 'valid', enabled: c.enabled, allowRestart: c.allowRestart } : runOnce(c);
  }).then((result) => console.log(JSON.stringify(result))).catch(() => {
    // Never print configuration or webhook URLs into launchd/journald output.
    console.error('Watchdog failed; check configuration, private state files, and supervisor permissions.');
    process.exitCode = 1;
  });
}

module.exports = { runOnce, validateConfig, probe, appendLog, notify };
