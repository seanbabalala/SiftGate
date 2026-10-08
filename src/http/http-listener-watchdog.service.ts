import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Server } from 'http';

export const LISTENER_CHECK_INTERVAL_MS = 5_000;
export const LISTENER_FAILURE_THRESHOLD = 2;

/** Only monitors the local HTTP listener, never database/provider readiness. */
@Injectable()
export class HttpListenerWatchdogService implements OnModuleDestroy {
  private readonly logger = new Logger(HttpListenerWatchdogService.name);
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private stopped = true;

  private readonly onClose = () => this.fail('unexpected_http_server_close');

  /** Called after app.listen() succeeds; startup is not a listener failure. */
  start(server: Server): void {
    this.stop();
    if (!server.listening) throw new Error('HTTP listener watchdog requires a listening server');
    this.server = server;
    this.stopped = false;
    this.failures = 0;
    server.on('close', this.onClose);
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.failures = server.listening ? 0 : this.failures + 1;
      if (this.failures >= LISTENER_FAILURE_THRESHOLD) this.fail('http_listener_missing');
    }, LISTENER_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.server?.removeListener('close', this.onClose);
    this.server = undefined;
  }

  onModuleDestroy(): void {
    // Nest calls destroy hooks before disposing the HTTP adapter.
    this.stop();
  }

  private fail(reason: string): void {
    if (this.stopped) return;
    this.stop();
    // Do not dump process.report: it can include credentials from the environment.
    // Avoid asynchronous teardown here: a broken listener must not wait forever
    // for unrelated shutdown hooks. The supervisor performs bounded recovery.
    this.logger.error(JSON.stringify({
      event: 'gateway_listener_lost', reason, pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()), timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  }
}
