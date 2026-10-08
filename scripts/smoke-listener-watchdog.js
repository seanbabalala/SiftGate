#!/usr/bin/env node
'use strict';
// Boots ONLY disposable child processes, on port 0, with fixture configuration.
// Does not contact providers, access the live database, or use a service manager.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const yaml = require('js-yaml');

async function runSmoke(runtime) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-listener-smoke-'));
  const children = [];
  try {
    const config = yaml.load(fs.readFileSync(path.join(__dirname, '../test/e2e/fixtures/gateway.e2e.yaml'), 'utf8'));
    config.server = { ...config.server, host: '127.0.0.1', port: 0 };
    config.database = { type: 'sqlite', path: ':memory:', log_retention_days: 0 };
    const configPath = path.join(directory, 'gateway.yaml');
    fs.writeFileSync(configPath, yaml.dump(config), { mode: 0o600 });
    const preload = path.join(directory, 'listener-test-only.cjs');
    fs.writeFileSync(preload, `
const http = require('node:http');
const original = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  if (args[0] !== 0) throw new Error('Smoke tests may bind only an ephemeral port');
  this.once('listening', () => process.stdout.write('SMOKE_PORT=' + this.address().port + '\\n'));
  process.on('message', (message) => {
    if (message === 'drop-test-listener') this.close();
  });
  return original.apply(this, args);
};
`);
    const boot = async () => {
      const child = spawn(process.execPath, ['--require', preload, path.join(runtime, 'dist/main.js')], {
        cwd: directory, env: { HOME: directory, PATH: process.env.PATH, NODE_ENV: 'test', GATEWAY_CONFIG_PATH: configPath },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      let output = '';
      child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-100000); });
      child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-100000); });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const deadline = Date.now() + 30000;
      let port;
      while (!port && Date.now() < deadline) {
        port = /SMOKE_PORT=(\d+)/.exec(output)?.[1];
        if (child.exitCode !== null || child.signalCode) throw new Error(`Candidate exited during startup: ${output.slice(-3000)}`);
        if (!port) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(port, 'Candidate must listen before startup timeout');
      assert.notEqual(Number(port), 2099, 'Smoke must not use the live port');
      const url = `http://127.0.0.1:${port}`;
      const live = await fetch(`${url}/live`, { signal: AbortSignal.timeout(5000) });
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { status: 'alive' });
      const ready = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(5000) });
      assert.equal(ready.status, 200);
      assert.equal((await ready.json()).ready, true);
      const page = await fetch(url, { signal: AbortSignal.timeout(5000) });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /id="root"/);
      return { child, exited, output: () => output, port: Number(port) };
    };
    const waitForExit = async (instance) => {
      let timeout;
      try {
        return await Promise.race([instance.exited, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Candidate did not exit in time')), 15000);
        })]);
      } finally { clearTimeout(timeout); }
    };
    const failure = await boot();
    failure.child.send('drop-test-listener');
    const failureExit = await waitForExit(failure);
    assert.equal(failureExit.code, 1);
    assert.match(failure.output(), /gateway_listener_lost/);
    const normal = await boot();
    normal.child.kill('SIGTERM');
    const normalExit = await waitForExit(normal);
    assert.ok(normalExit.code === 0 || normalExit.signal === 'SIGTERM', `Unexpected normal shutdown: ${JSON.stringify(normalExit)}`);
    assert.doesNotMatch(normal.output(), /gateway_listener_lost/);
    return { passed: true, live_port_used: false, temporary_ports: [failure.port, normal.port],
      live_and_ready: true, frontend: true, unexpected_close_exit: failureExit.code, graceful_shutdown: normalExit };
  } finally {
    for (const child of children) {
      if (child.exitCode === null && !child.signalCode) {
        const stopped = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await stopped;
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const { values } = parseArgs({ options: { runtime: { type: 'string' } } });
  runSmoke(path.resolve(values.runtime || path.join(__dirname, '..')))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runSmoke };
