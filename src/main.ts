import './config/register-local-env';
import { shutdownTelemetry } from './telemetry/instrumentation'; // OTel SDK — must run before NestJS imports
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { json, raw, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { setupOpenApi } from './openapi/setup-openapi';
import { HttpListenerWatchdogService } from './http/http-listener-watchdog.service';
import { PricingRuntimeService } from './pricing/pricing-runtime.service';
import { PipelineService } from './pipeline/pipeline.service';
import { RequestDrainingExpressAdapter } from './http/graceful-shutdown';

async function bootstrap() {
  const adapter = new RequestDrainingExpressAdapter();
  const app = await NestFactory.create(AppModule, adapter);
  const logger = new Logger('Bootstrap');
  const config = app.get(ConfigService);

  // Enable global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  setupOpenApi(app);

  // Helmet — standard security response headers
  if (config.server.helmet !== false) {
    app.use(helmet());
  }

  // Configurable CORS
  const corsConfig = config.server.cors ?? { origin: false, credentials: false };
  app.enableCors({
    origin: corsConfig.origin,
    credentials: corsConfig.credentials ?? false,
  });

  // Body size limit
  const bodyLimit = config.server.body_limit ?? '1mb';
  const mediaBodyTypes = [
    'multipart/form-data',
    'application/octet-stream',
    'audio/*',
    'image/*',
  ];
  for (const route of [
    '/v1/images/generations',
    '/v1/images/edits',
    '/v1/images/variations',
    '/v1/audio/transcriptions',
    '/v1/audio/translations',
    '/v1/audio/speech',
  ]) {
    app.use(route, raw({ type: mediaBodyTypes, limit: bodyLimit }));
  }
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  app.use(
    (
      req: { method: string; originalUrl?: string; url: string },
      res: { once: (event: string, listener: () => void) => void },
      next: () => void,
    ) => {
      const startedAt = Date.now();
      res.once('finish', () => {
        const durationMs = Date.now() - startedAt;
        const path = req.originalUrl || req.url;
        if (durationMs >= 1000 && path.startsWith('/api/dashboard')) {
          logger.warn(
            `Slow request: ${req.method} ${path} ${durationMs}ms`,
          );
        }
      });
      next();
    },
  );

  // Trust proxy — required to get real client IP behind reverse proxies
  if (config.server.trust_proxy) {
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set('trust proxy', config.server.trust_proxy);
  }

  // SPA fallback: for any GET that doesn't match API/v1/health/ready/cluster/static-asset,
  // serve index.html so client-side routing works on page refresh
  const expressApp = app.getHttpAdapter().getInstance();
  const indexPath = join(__dirname, '..', 'frontend', 'dist', 'index.html');
  const apiPrefixes = ['/api', '/v1', '/live', '/health', '/ready', '/cluster'];

  expressApp.use(
    (
      req: { method: string; url: string; path: string },
      res: { sendFile: (path: string) => void },
      next: () => void,
    ) => {
      // Only intercept GET requests
      if (req.method !== 'GET') return next();
      // Skip API routes
      if (apiPrefixes.some((p) => req.path.startsWith(p))) return next();
      // Skip static assets (files with extensions)
      if (/\.\w+$/.test(req.path)) return next();
      // SPA fallback — serve index.html
      res.sendFile(indexPath);
    },
  );

  const { port, host } = config.server;

  // Graceful shutdown
  const listenerWatchdog = app.get(HttpListenerWatchdogService);
  adapter.setRequestDrain(async () => {
    await app.get(PricingRuntimeService).waitForRequests();
    // A request can finish its accounting and enqueue a write-behind log after
    // beforeApplicationShutdown already flushed the then-empty queues.
    // Drain those final writes before Nest disposes the database connection.
    await app.get(PipelineService).drainPendingLogWrites();
  });
  // Do not also enable Nest's signal handlers: they would race this drain and
  // close database providers while the final SSE requests are still settling.
  const shutdownTimeout = config.server.shutdown_timeout_ms ?? 5000;
  let shutdownStarted = false;
  const handleShutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.log(`Graceful shutdown initiated (timeout: ${shutdownTimeout}ms)...`);
    const deadline = setTimeout(() => process.exit(1), shutdownTimeout);
    try {
      listenerWatchdog.stop();
      adapter.stopAccepting();
      await app.close();
      await shutdownTelemetry();
      clearTimeout(deadline);
      process.exit(0);
    } catch {
      logger.error('Graceful shutdown did not complete; retained accounting requires recovery.');
      clearTimeout(deadline);
      process.exit(1);
    }
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);

  await app.listen(port, host);
  listenerWatchdog.start(app.getHttpServer());

  logger.log(`SiftGate running on http://${host}:${port}`);
  logger.log(`Nodes configured: ${config.nodes.map((n) => n.id).join(', ')}`);
}

bootstrap();
