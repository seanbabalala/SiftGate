import { PricingRuntimeService } from '../../src/pricing/pricing-runtime.service';
import type { PricingRepository } from '../../src/pricing/pricing-repository';
import type { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import type { ConfigService } from '../../src/config/config.service';
import type { MediaTaskService } from '../../src/pricing/media-task.service';
import { RequestDrainingExpressAdapter } from '../../src/http/graceful-shutdown';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Server } from 'node:http';

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const runtime = () => new PricingRuntimeService(
  {} as PricingRepository, {} as CostLedgerService,
  {} as ConfigService, {} as MediaTaskService,
);
const canonical = { metadata: { source_format: 'chat_completions' as const, raw_headers: {} } };

describe('request accounting shutdown drain', () => {
  it('waits for work after the HTTP body and retains the caller result', async () => {
    const service = runtime(), settled = gate();
    const request = service.runRequest('a', canonical, 'default-workspace', async () => {
      await settled.promise;
      return 'settled';
    });
    let drained = false;
    const drain = service.waitForRequests().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    settled.resolve();
    await expect(request).resolves.toBe('settled');
    await drain;
    await expect(service.waitForRequests()).resolves.toBeUndefined();
  });

  it('includes work admitted while draining and does not leak rejected requests', async () => {
    const service = runtime(), first = gate(), second = gate();
    const a = service.runRequest('a', canonical, 'workspace-a', async () => { await first.promise; });
    let drained = false;
    const drain = service.waitForRequests().then(() => { drained = true; });
    const b = service.runRequest('b', canonical, 'workspace-b', async () => { await second.promise; throw new Error('synthetic failure'); });
    const rejected = expect(b).rejects.toThrow('synthetic failure');
    first.resolve(); await a; await Promise.resolve();
    expect(drained).toBe(false);
    second.resolve(); await rejected; await drain;
    await expect(service.waitForRequests()).resolves.toBeUndefined();
  });

  it('closes HTTP only once and drains post-response work before adapter disposal completes', async () => {
    const ingress = gate(), accounting = gate();
    const close = jest.spyOn(ExpressAdapter.prototype, 'close').mockReturnValue(ingress.promise);
    try {
      const adapter = new RequestDrainingExpressAdapter();
      const drain = jest.fn(() => accounting.promise);
      adapter.setRequestDrain(drain);
      adapter.stopAccepting(); adapter.stopAccepting();
      let finished = false;
      const result = adapter.close().then(() => { finished = true; });
      expect(close).toHaveBeenCalledTimes(1);
      expect(drain).not.toHaveBeenCalled();
      ingress.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(drain).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false);
      accounting.resolve(); await result;
      expect(finished).toBe(true);
    } finally { close.mockRestore(); }
  });

  it('lets Nest close upgraded sockets, then drains accounting before database shutdown hooks', async () => {
    const upgraded = gate(), accounting = gate(), draining = gate();
    let peer: Duplex | undefined, client: Socket | undefined;
    let databaseClosed = false, transportsClosed = false;
    class Transport {
      onModuleDestroy() { transportsClosed = true; peer?.destroy(); }
    }
    class Database {
      onApplicationShutdown() { databaseClosed = true; }
    }
    @Module({ providers: [Transport, Database] })
    class FixtureModule {}
    const adapter = new RequestDrainingExpressAdapter();
    adapter.setRequestDrain(async () => { draining.resolve(); await accounting.promise; });
    const app = await NestFactory.create(FixtureModule, adapter, { logger: false });
    let closing: Promise<void> | undefined;
    try {
      await app.listen(0, '127.0.0.1');
      const server = app.getHttpServer() as Server;
      const address = server.address();
      if (!address || typeof address === 'string' || address.port === 2099) throw new Error('Unsafe test listener');
      server.on('upgrade', (_request, socket) => { peer = socket; upgraded.resolve(); });
      client = connect(address.port, '127.0.0.1', () => {
        client!.write('GET / HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');
      });
      client.on('error', () => undefined);
      await upgraded.promise;
      adapter.stopAccepting();
      closing = app.close();
      await draining.promise;
      expect(transportsClosed).toBe(true);
      expect(databaseClosed).toBe(false);
      accounting.resolve(); await closing;
      expect(databaseClosed).toBe(true);
    } finally {
      accounting.resolve(); peer?.destroy(); client?.destroy();
      await (closing ?? app.close());
    }
  });

  it('propagates a drain failure rather than declaring disposal complete', async () => {
    const close = jest.spyOn(ExpressAdapter.prototype, 'close').mockResolvedValue(undefined);
    try {
      const adapter = new RequestDrainingExpressAdapter();
      adapter.setRequestDrain(async () => { throw new Error('synthetic drain failure'); });
      await expect(adapter.close()).rejects.toThrow('synthetic drain failure');
    } finally { close.mockRestore(); }
  });
});
