import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

const source = readFileSync(join(__dirname, '../../src/telemetry/instrumentation.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

function initialize(options: { enabled?: boolean; shutdown?: () => Promise<void>; start?: () => void } = {}) {
  const process = { env: { GATEWAY_CONFIG_PATH: '/isolated/telemetry-fixture.yaml' }, cwd: () => '/isolated', on: jest.fn(), exit: jest.fn() };
  const start = jest.fn(options.start ?? (() => undefined));
  const shutdown = jest.fn(options.shutdown ?? (() => Promise.resolve()));
  const required: string[] = [];
  const sdkOptions: unknown[] = [];
  const exports: { shutdownTelemetry?: () => Promise<void> } = {};
  const modules: Record<string, unknown> = {
    fs: { existsSync: () => true, readFileSync: () => 'synthetic config' },
    path: { resolve: (...parts: string[]) => parts.join('/') },
    'js-yaml': { load: () => ({ telemetry: { enabled: options.enabled ?? true } }) },
    '@opentelemetry/sdk-node': { NodeSDK: class { constructor(config: unknown) { sdkOptions.push(config); } start = start; shutdown = shutdown; } },
    '@opentelemetry/exporter-trace-otlp-proto': { OTLPTraceExporter: class {} },
    '@opentelemetry/exporter-prometheus': { PrometheusExporter: class {} },
    '@opentelemetry/instrumentation-http': { HttpInstrumentation: class {} },
    '@opentelemetry/resources': { resourceFromAttributes: (attributes: unknown) => attributes },
    '@opentelemetry/semantic-conventions': { ATTR_SERVICE_NAME: 'service.name', ATTR_SERVICE_VERSION: 'service.version' },
  };
  runInNewContext(code, { exports, process, console: { log: jest.fn(), warn: jest.fn() }, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected telemetry dependency: ${name}`);
    required.push(name); return modules[name];
  } });
  return { exports, process, required, start, shutdown, sdkOptions };
}

async function initializeMain(options: { flush?: () => Promise<void>; logs?: () => Promise<void> } = {}) {
  const accounting = gate(), ready = gate(), flushing = gate(), logging = gate();
  const events: string[] = [];
  const telemetry = initialize({ shutdown: async () => { events.push('telemetry-flush'); flushing.resolve(); await options.flush?.(); } });
  const handlers = new Map<string, () => Promise<void>>();
  telemetry.process.on.mockImplementation((name: string, handler: () => Promise<void>) => { handlers.set(name, handler); });
  const deadline = jest.fn(), clearDeadline = jest.fn();
  class Config {}
  class Watchdog {}
  class Runtime {}
  class Pipeline {}
  let drain: (() => Promise<void>) | undefined;
  class Adapter {
    setRequestDrain = jest.fn((callback: () => Promise<void>) => { drain = callback; });
    stopAccepting() { events.push('ingress-close'); }
    getInstance() { return { set: jest.fn(), use: jest.fn() }; }
  }
  const app = {
    get: (type: unknown) => type === Config ? { server: { host: '127.0.0.1', port: 0, shutdown_timeout_ms: 5000 }, nodes: [] }
      : type === Watchdog ? { stop: () => events.push('watchdog-stop'), start: jest.fn() }
      : type === Runtime ? { waitForRequests: async () => { await accounting.promise; events.push('accounting-complete'); } }
      : type === Pipeline ? { drainPendingLogWrites: async () => { events.push('log-drain'); logging.resolve(); await options.logs?.(); events.push('logs-complete'); } } : undefined,
    useGlobalPipes: jest.fn(), enableCors: jest.fn(), use: jest.fn(),
    getHttpAdapter: () => new Adapter(), getHttpServer: () => ({}),
    listen: async () => { ready.resolve(); },
    close: async () => { events.push('app-close'); await drain?.(); events.push('database-close'); },
  };
  const modules: Record<string, unknown> = {
    './config/register-local-env': {}, './telemetry/instrumentation': telemetry.exports,
    '@nestjs/core': { NestFactory: { create: async () => app } },
    '@nestjs/common': { Logger: class { log = jest.fn(); error = jest.fn(); }, ValidationPipe: class {} },
    path: { join: (...parts: string[]) => parts.join('/') }, express: { json: jest.fn(), raw: jest.fn(), urlencoded: jest.fn() },
    helmet: () => undefined, './app.module': { AppModule: class {} }, './config/config.service': { ConfigService: Config },
    './openapi/setup-openapi': { setupOpenApi: jest.fn() },
    './http/http-listener-watchdog.service': { HttpListenerWatchdogService: Watchdog },
    './pricing/pricing-runtime.service': { PricingRuntimeService: Runtime },
    './pipeline/pipeline.service': { PipelineService: Pipeline },
    './http/graceful-shutdown': { RequestDrainingExpressAdapter: Adapter },
  };
  const main = ts.transpileModule(readFileSync(join(__dirname, '../../src/main.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  runInNewContext(main, { exports: {}, __dirname: '/isolated/dist', process: telemetry.process,
    setTimeout: deadline, clearTimeout: clearDeadline, require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected main dependency: ${name}`);
      return modules[name];
    } });
  await ready.promise;
  return { accounting, flushing, logging, events, telemetry, handlers, deadline, clearDeadline };
}

describe('telemetry participates in the gateway-owned shutdown', () => {
  it('does not install competing exit-signal handlers when enabled', () => {
    const fixture = initialize();
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.process.on).not.toHaveBeenCalled();
    expect(fixture.process.exit).not.toHaveBeenCalled();
  });

  it('waits for one shared SDK shutdown promise without exiting the process', async () => {
    const finished = gate();
    const fixture = initialize({ shutdown: () => finished.promise });
    const a = fixture.exports.shutdownTelemetry!(), b = fixture.exports.shutdownTelemetry!();
    let done = false;
    void a.then(() => { done = true; });
    await Promise.resolve();
    expect(fixture.shutdown).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    finished.resolve(); await Promise.all([a, b]);
    await fixture.exports.shutdownTelemetry!();
    expect(fixture.shutdown).toHaveBeenCalledTimes(1);
    expect(fixture.process.exit).not.toHaveBeenCalled();
  });

  it('does not load or stop optional SDK packages when telemetry is disabled', async () => {
    const fixture = initialize({ enabled: false });
    expect(fixture.required.some(name => name.startsWith('@opentelemetry/'))).toBe(false);
    await fixture.exports.shutdownTelemetry!();
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.process.on).not.toHaveBeenCalled();
  });

  it('reports flush failure to the owner instead of independently exiting or repeating shutdown', async () => {
    const fixture = initialize({ shutdown: async () => { throw new Error('Synthetic exporter failure'); } });
    await expect(fixture.exports.shutdownTelemetry!()).rejects.toThrow('Synthetic exporter failure');
    await expect(fixture.exports.shutdownTelemetry!()).rejects.toThrow('Synthetic exporter failure');
    expect(fixture.shutdown).toHaveBeenCalledTimes(1);
    expect(fixture.process.exit).not.toHaveBeenCalled();
  });

  it('can dispose a constructed SDK after startup fails without owning process signals', async () => {
    const fixture = initialize({ start: () => { throw new Error('Synthetic startup failure'); } });
    await fixture.exports.shutdownTelemetry!();
    expect(fixture.shutdown).toHaveBeenCalledTimes(1);
    expect(fixture.process.on).not.toHaveBeenCalled();
    expect(fixture.process.exit).not.toHaveBeenCalled();
  });

  it('wires main to drain the application before telemetry and exits only after both finish', async () => {
    const exported = gate();
    const fixture = await initializeMain({ flush: () => exported.promise });
    expect(fixture.telemetry.process.on.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGINT']);
    const closing = fixture.handlers.get('SIGTERM')!();
    await fixture.handlers.get('SIGINT')!();
    expect(fixture.deadline).toHaveBeenCalledTimes(1);
    expect(fixture.deadline.mock.calls[0][1]).toBe(5000);
    expect(fixture.events).toEqual(['watchdog-stop', 'ingress-close', 'app-close']);
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
    expect(fixture.telemetry.process.exit).not.toHaveBeenCalled();
    fixture.accounting.resolve(); await fixture.flushing.promise;
    expect(fixture.events).toEqual(['watchdog-stop', 'ingress-close', 'app-close', 'accounting-complete', 'log-drain', 'logs-complete', 'database-close', 'telemetry-flush']);
    expect(fixture.telemetry.process.exit).not.toHaveBeenCalled();
    exported.resolve(); await closing;
    expect(fixture.telemetry.process.exit).toHaveBeenCalledTimes(1);
    expect(fixture.telemetry.process.exit).toHaveBeenCalledWith(0);
    expect(fixture.clearDeadline).toHaveBeenCalledTimes(1);
  });

  it('main reports a telemetry flush failure as nonzero only after accounting is drained', async () => {
    const fixture = await initializeMain({ flush: async () => { throw new Error('Synthetic exporter failure'); } });
    const closing = fixture.handlers.get('SIGTERM')!();
    fixture.accounting.resolve(); await closing;
    expect(fixture.events.indexOf('accounting-complete')).toBeLessThan(fixture.events.indexOf('telemetry-flush'));
    expect(fixture.telemetry.process.exit).toHaveBeenCalledWith(1);
    expect(fixture.telemetry.process.exit).toHaveBeenCalledTimes(1);
  });

  it('drains late write-behind logs after requests and before database disposal or telemetry shutdown', async () => {
    const written = gate();
    const fixture = await initializeMain({ logs: () => written.promise });
    const closing = fixture.handlers.get('SIGTERM')!();
    try {
      fixture.accounting.resolve(); await fixture.logging.promise;
      expect(fixture.events).toEqual(['watchdog-stop', 'ingress-close', 'app-close', 'accounting-complete', 'log-drain']);
      expect(fixture.telemetry.process.exit).not.toHaveBeenCalled();
      expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
    } finally { written.resolve(); await closing; }
    expect(fixture.events.slice(-3)).toEqual(['logs-complete', 'database-close', 'telemetry-flush']);
    expect(fixture.telemetry.process.exit).toHaveBeenCalledWith(0);
  });
});
