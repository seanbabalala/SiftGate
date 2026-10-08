import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
const { stageBundle } = require('../../scripts/stage-macos-watchdog');

describe('macOS watchdog staging never activates a deployment', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-watchdog-stage-test-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('writes a disabled bundle only, with safely quoted paths and a valid launcher', () => {
    const install = path.join(dir, "future install's runtime");
    const output = path.join(dir, 'staged');
    const result = stageBundle({ outputDir: output, installDir: install,
      nodePath: process.execPath, service: 'com.example.gateway' });
    expect(result.enabled).toBe(false);
    expect(result.allowRestart).toBe(false);
    expect(fs.existsSync(install)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(output, 'watchdog.config.json'), 'utf8'))).toMatchObject({
      enabled: false, allowRestart: false, stateDirectory: path.join(install, 'state'),
    });
    execFileSync('/bin/bash', ['-n', path.join(output, 'run-watchdog.sh')]);
    const plist = fs.readFileSync(path.join(output, 'com.example.gateway.watchdog.plist'), 'utf8');
    expect(plist).toContain('<key>RunAtLoad</key><false/>');
    expect(plist).toContain('<key>StartInterval</key><integer>30</integer>');
  });
  it('refuses protected locations and writing into the installation directory', () => {
    const options = { outputDir: path.join(dir, 'out'), nodePath: process.execPath, service: 'com.example.gateway' };
    expect(() => stageBundle({ ...options, installDir: path.join(os.homedir(), 'Desktop', 'watchdog') })).toThrow();
    expect(() => stageBundle({ ...options, installDir: options.outputDir })).toThrow();
    expect(fs.existsSync(options.outputDir)).toBe(false);
  });
  it('keeps the systemd state directory private and its example disabled', () => {
    const unit = fs.readFileSync(path.resolve(__dirname, '../../deploy/systemd/siftgate-watchdog.service'), 'utf8');
    expect(unit).toContain('StateDirectoryMode=0700');
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../deploy/systemd/watchdog.config.example.json'), 'utf8'));
    expect(config).toMatchObject({ enabled: false, allowRestart: false, manager: 'systemd' });
  });
});
