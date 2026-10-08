import { EventEmitter } from 'events';
import type { Server } from 'http';
import { Logger } from '@nestjs/common';
import { HttpListenerWatchdogService, LISTENER_CHECK_INTERVAL_MS } from '../../src/http/http-listener-watchdog.service';

describe('HTTP listener watchdog', () => {
  let watchdog: HttpListenerWatchdogService;
  let server: EventEmitter & { listening: boolean };
  let exit: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    watchdog = new HttpListenerWatchdogService();
    server = Object.assign(new EventEmitter(), { listening: true });
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { watchdog.stop(); jest.useRealTimers(); jest.restoreAllMocks(); });
  it('does not run during startup and tolerates a healthy listener', () => {
    jest.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
    watchdog.start(server as Server);
    jest.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
  });
  it('exits on an unexpected close even if no other handles remain', () => {
    watchdog.start(server as Server);
    server.listening = false;
    server.emit('close');
    expect(exit).toHaveBeenCalledWith(1);
    expect(server.listenerCount('close')).toBe(0);
  });
  it('detects a lost listener while existing streams delay the close event', () => {
    watchdog.start(server as Server);
    server.listening = false;
    jest.advanceTimersByTime(LISTENER_CHECK_INTERVAL_MS);
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(LISTENER_CHECK_INTERVAL_MS);
    expect(exit).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });
  it('resets a transient missing-listener sample', () => {
    watchdog.start(server as Server);
    server.listening = false;
    jest.advanceTimersByTime(LISTENER_CHECK_INTERVAL_MS);
    server.listening = true;
    jest.advanceTimersByTime(LISTENER_CHECK_INTERVAL_MS);
    server.listening = false;
    jest.advanceTimersByTime(LISTENER_CHECK_INTERVAL_MS);
    expect(exit).not.toHaveBeenCalled();
  });
  it.each(['stop', 'onModuleDestroy'] as const)('does not restart an intentional %s', (method) => {
    watchdog.start(server as Server);
    watchdog[method]();
    server.listening = false;
    server.emit('close');
    jest.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
  });
});
