import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { healthcheckPort, checkHealth } = require('../../scripts/docker-healthcheck.js') as {
  healthcheckPort(env?: Record<string, unknown>): number | null;
  checkHealth(env?: Record<string, unknown>, fetcher?: typeof fetch): Promise<number>;
};

describe('container liveness probe', () => {
  it('keeps the default port without consulting unrelated environment variables', () => {
    expect(healthcheckPort({})).toBe(2099);
    expect(healthcheckPort({ PORT: '1234', GATEWAY_CONFIG_PATH: '/not-read' })).toBe(2099);
    expect(healthcheckPort({ SIFTGATE_HEALTHCHECK_PORT: '65535' })).toBe(65535);
  });

  it.each(['', '0', '-1', '65536', '1.5', ' 2099', '2099 ', '02099', '1e3', '2099@remote.invalid', '1234/path', '1234?url=remote', 2099])('rejects invalid probe port %p before connecting', async value => {
    const fetcher = jest.fn();
    expect(healthcheckPort({ SIFTGATE_HEALTHCHECK_PORT: value })).toBeNull();
    expect(await checkHealth({ SIFTGATE_HEALTHCHECK_PORT: value }, fetcher)).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses only loopback /live, rejects redirects and supplies a bounded abort signal', async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    // Default-port behavior is inspected with a mock; no connection to2099 is made.
    expect(await checkHealth({}, fetcher)).toBe(0);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:2099/live', {
      signal: expect.any(AbortSignal), redirect: 'error',
    });
    expect(await checkHealth({}, jest.fn().mockResolvedValue(new Response('', { status: 503 })))).toBe(1);
    expect(await checkHealth({}, jest.fn().mockRejectedValue(new Error('connection refused')))).toBe(1);
  });

  it('runs the packaged command against a real temporary listener and returns failure when it is gone', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => { requests.push(request.url!); response.end('ok'); });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string' || address.port === 2099) throw new Error('Use a private temporary port');
    const script = resolve(__dirname, '../../scripts/docker-healthcheck.js');
    const run = () => new Promise<number | null>((resolveExit, reject) => {
      const child = spawn(process.execPath, [script], { env: { SIFTGATE_HEALTHCHECK_PORT: String(address.port) }, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Probe failed to exit within its bound')); }, 6000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); signal ? reject(new Error(`Unexpected probe signal ${signal}`)) : resolveExit(code); });
    });
    try { expect(await run()).toBe(0); expect(requests).toEqual(['/live']); }
    finally { server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
    expect(await run()).toBe(1);
  });

  it('is copied into the image and invoked by its actual exec-form HEALTHCHECK', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY scripts/docker-healthcheck.js ./scripts/docker-healthcheck.js');
    expect(dockerfile).toContain('CMD ["node", "scripts/docker-healthcheck.js"]');
    expect(dockerfile).toContain('--timeout=5s');
  });
});
