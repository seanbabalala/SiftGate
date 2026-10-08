import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const { runOnce, validateConfig, appendLog } = require('../../scripts/gateway-watchdog');

describe('External gateway watchdog (no real service-manager calls)', () => {
  let dir: string;
  let config: Record<string, unknown>;
  let now: number;
  let deps: { probe: jest.Mock; restart: jest.Mock; notify: jest.Mock; sleep: jest.Mock; now: () => number };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-watchdog-test-'));
    now = 1_000_000;
    config = { enabled: true, allowRestart: true, manager: 'launchd', service: 'com.example.gateway',
      healthUrl: 'http://127.0.0.1:19999/live', stateDirectory: path.join(dir, 'state'),
      maintenanceFile: path.join(dir, 'maintenance'), startupGraceMs: 1 };
    deps = { probe: jest.fn().mockResolvedValue(false), restart: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(true), sleep: jest.fn().mockResolvedValue(undefined), now: () => now };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('is inert when disabled, including no state directory creation', async () => {
    expect(await runOnce({ ...config, enabled: false }, deps)).toEqual({ status: 'disabled' });
    expect(fs.existsSync(String(config.stateDirectory))).toBe(false);
    expect(deps.probe).not.toHaveBeenCalled();
  });
  it('requires consecutive HTTP failures and verifies recovery', async () => {
    expect((await runOnce(config, deps)).status).toBe('waiting');
    deps.probe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await runOnce(config, deps)).status).toBe('restarted');
    expect(deps.restart).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls.map((call) => call[1].event)).toContain('gateway_recovered');
  });
  it('does not restart in observe-only mode or during maintenance', async () => {
    await runOnce(config, deps);
    expect((await runOnce({ ...config, allowRestart: false }, deps)).status).toBe('restart_suppressed');
    fs.writeFileSync(String(config.maintenanceFile), '');
    expect((await runOnce(config, deps)).status).toBe('maintenance');
    expect(deps.restart).not.toHaveBeenCalled();
  });
  it('rechecks the maintenance gate immediately before restarting', async () => {
    await runOnce(config, deps);
    deps.notify.mockImplementation(async (_config, event) => {
      if (event.event === 'gateway_restart_attempt') fs.writeFileSync(String(config.maintenanceFile), '');
      return true;
    });
    expect((await runOnce(config, deps)).status).toBe('maintenance');
    expect(deps.restart).not.toHaveBeenCalled();
  });
  it('persists a restart cap and cooldown across independent runs', async () => {
    config.failureThreshold = 1;
    config.maxRestarts = 2;
    expect((await runOnce(config, deps)).status).toBe('restart_unhealthy');
    expect((await runOnce(config, deps)).status).toBe('rate_limited');
    now += 121_000;
    expect((await runOnce(config, deps)).status).toBe('restart_unhealthy');
    now += 121_000;
    expect((await runOnce(config, deps)).status).toBe('rate_limited');
    expect(deps.restart).toHaveBeenCalledTimes(2);
  });
  it('records a failed restart without resetting the rate limit', async () => {
    config.failureThreshold = 1;
    deps.restart.mockRejectedValue(new Error('manager failed'));
    expect((await runOnce(config, deps)).status).toBe('restart_failed');
    expect((await runOnce(config, deps)).status).toBe('rate_limited');
  });
  it('fails closed on corrupt state', async () => {
    await runOnce(config, deps);
    fs.writeFileSync(path.join(String(config.stateDirectory), 'state.json'), '{broken');
    await expect(runOnce(config, deps)).rejects.toThrow();
    expect(deps.restart).not.toHaveBeenCalled();
  });
  it('does not overlap an active run', async () => {
    let resolveProbe!: (healthy: boolean) => void;
    deps.probe.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveProbe = resolve; }));
    const active = runOnce(config, deps);
    expect((await runOnce(config, deps)).status).toBe('locked');
    resolveProbe(true);
    await active;
    expect(deps.restart).not.toHaveBeenCalled();
  });
  it('rejects remote health URLs and arbitrary command/service inputs', () => {
    expect(() => validateConfig({ ...config, healthUrl: 'https://example.com/live' })).toThrow();
    expect(() => validateConfig({ ...config, service: '--all' })).toThrow();
    expect(() => validateConfig({ ...config, healthUrl: 'http://127.0.0.1:19999/health' })).toThrow();
  });
  it('rotates its own bounded logs', () => {
    const c = validateConfig({ ...config, logMaxBytes: 1 });
    fs.mkdirSync(c.stateDirectory, { mode: 0o700 });
    for (let i = 0; i < 8; i++) appendLog(c, { event: 'test', i });
    expect(fs.readdirSync(c.stateDirectory).sort()).toEqual(['watchdog.log', 'watchdog.log.1', 'watchdog.log.2', 'watchdog.log.3']);
  });
});
