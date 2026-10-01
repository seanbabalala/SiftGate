// A one-shot container probe. Never load gateway config, mutate data or restart a service.
function healthcheckPort(env = process.env) {
  const value = env.SIFTGATE_HEALTHCHECK_PORT ?? '2099';
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

async function checkHealth(env = process.env, fetcher = globalThis.fetch) {
  const port = healthcheckPort(env);
  if (port === null) return 1;
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/live`, {
      signal: AbortSignal.timeout(4000),
      redirect: 'error',
    });
    await response.body?.cancel();
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

module.exports = { healthcheckPort, checkHealth };
if (require.main === module) checkHealth().then(code => process.exit(code));
