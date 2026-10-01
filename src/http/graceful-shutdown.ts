import { ExpressAdapter } from '@nestjs/platform-express';

/** Drain at Nest's HTTP-disposal boundary, before database onApplicationShutdown. */
export class RequestDrainingExpressAdapter extends ExpressAdapter {
  private ingressClosed?: Promise<void>;
  private drainRequests?: () => Promise<void>;

  setRequestDrain(drain: () => Promise<void>): void {
    this.drainRequests = drain;
  }

  stopAccepting(): void {
    // Start closing without awaiting: Nest's module-destroy hooks must still be
    // able to close upgraded Realtime sockets, which also keep server.close pending.
    this.ingressClosed ??= Promise.resolve(super.close()).then(() => undefined);
  }

  async close(): Promise<void> {
    this.stopAccepting();
    await this.ingressClosed;
    // SSE may have finished on the wire before its accounting/logging promise.
    await this.drainRequests?.();
  }
}
