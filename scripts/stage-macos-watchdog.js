#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { validateConfig } = require('./gateway-watchdog');

const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shell = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

function stageBundle(options) {
  for (const key of ['outputDir', 'installDir', 'nodePath']) {
    if (!options[key] || !path.isAbsolute(options[key])) throw new Error(`${key} must be absolute`);
  }
  const outputDir = path.resolve(options.outputDir);
  const installDir = path.resolve(options.installDir);
  if (outputDir === installDir || outputDir.startsWith(installDir + path.sep)) {
    throw new Error('Stage outside the installation directory; this command must not activate anything');
  }
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const protectedRoot = path.join(os.homedir(), name);
    if (installDir === protectedRoot || installDir.startsWith(protectedRoot + path.sep)) {
      throw new Error('macOS watchdog must be installed outside protected user folders');
    }
  }
  const config = validateConfig({
    enabled: false, allowRestart: false, manager: 'launchd', service: options.service,
    healthUrl: options.healthUrl || 'http://127.0.0.1:2099/live',
    stateDirectory: path.join(installDir, 'state'), maintenanceFile: path.join(installDir, 'maintenance'),
    ...(options.dataDir ? { dataDirectory: options.dataDir, minFreeBytes: 5 * 1024 ** 3 } : {}),
    ...(options.databasePath ? { databasePath: options.databasePath, maxDatabaseBytes: 4 * 1024 ** 3 } : {}),
    ...(options.alertChannelsFile ? { alertChannelsFile: options.alertChannelsFile } : {}),
  });
  // Existing bundles are not overwritten. No writes happen under installDir,
  // ~/Library/LaunchAgents, or an active release; no launchctl calls exist here.
  fs.mkdirSync(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputDir, { mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, 'gateway-watchdog.js'), path.join(outputDir, 'gateway-watchdog.js'));
  fs.mkdirSync(path.join(outputDir, 'lib'), { mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, '../src/alerts/alert-connector-runtime.js'), path.join(outputDir, 'lib/alert-connectors.js'));
  fs.writeFileSync(path.join(outputDir, 'watchdog.config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const runner = `#!/bin/bash
set -eu
umask 077
STATE=${shell(config.stateDirectory)}
mkdir -p "$STATE"
LOG="$STATE/bootstrap-errors.log"
# Rotate before invoking Node, even when its configuration is invalid.
if [ -L "$LOG" ]; then exit 1; fi
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -ge 1048576 ]; then
  for n in 2 1; do
    [ ! -f "$LOG.$n" ] || mv -f "$LOG.$n" "$LOG.$((n + 1))"
  done
  mv -f "$LOG" "$LOG.1"
fi
exec ${shell(options.nodePath)} ${shell(path.join(installDir, 'gateway-watchdog.js'))} ${shell(path.join(installDir, 'watchdog.config.json'))} >/dev/null 2>>"$LOG"
`;
  fs.writeFileSync(path.join(outputDir, 'run-watchdog.sh'), runner, { mode: 0o700 });
  const label = `${config.service}.watchdog`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>${xml(path.join(installDir, 'run-watchdog.sh'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(installDir)}</string>
  <key>RunAtLoad</key><false/>
  <key>StartInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
  fs.writeFileSync(path.join(outputDir, `${label}.plist`), plist, { mode: 0o600 });
  fs.writeFileSync(path.join(outputDir, 'STAGED-NOT-ACTIVE.txt'),
    'This bundle is disabled. Installing/loading it and enabling restarts require an approved maintenance window. See docs/RELIABILITY_OPERATIONS.md.\n');
  return { outputDir, installDir, label, enabled: false, allowRestart: false };
}

if (require.main === module) {
  try {
    const { values } = parseArgs({ options: {
      'output-dir': { type: 'string' }, 'install-dir': { type: 'string' }, node: { type: 'string' },
      service: { type: 'string' }, 'health-url': { type: 'string' },
      'data-dir': { type: 'string' }, 'database-path': { type: 'string' },
      'alert-channels-file': { type: 'string' },
    } });
    console.log(JSON.stringify(stageBundle({
      outputDir: values['output-dir'], installDir: values['install-dir'], nodePath: values.node,
      service: values.service, healthUrl: values['health-url'], dataDir: values['data-dir'], databasePath: values['database-path'],
      alertChannelsFile: values['alert-channels-file'],
    }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { stageBundle };
