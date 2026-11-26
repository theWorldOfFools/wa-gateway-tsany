import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance
} from 'fastify';
import { fileURLToPath } from 'node:url';
import { pingDb } from './db/index.js';
import { ApiError } from './errors.js';
import { createAuthenticator } from './http/auth.js';
import type { HttpDeps } from './http/deps.js';
import { registerAnalysisRoutes } from './http/routes/analysis.js';
import { registerAnalyticsRoutes } from './http/routes/analytics.js';
import { registerAuthRoutes } from './http/routes/auth.js';
import { registerGroupRoutes } from './http/routes/groups.js';
import { registerMediaRoutes } from './http/routes/media.js';
import { registerMessageRoutes } from './http/routes/messages.js';
import { registerPublicRoutes } from './http/routes/public.js';
import { registerSessionRoutes } from './http/routes/sessions.js';
import { registerTenantRoutes } from './http/routes/tenants.js';

export async function buildApp(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: deps.config.TRUST_PROXY
  }) as unknown as FastifyInstance;

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: {
        code: 'not_found',
        message: `Route ${request.method} ${request.url} was not found`
      }
    });
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error(
          { err: error, code: error.code },
          'Request failed with a server error'
        );
      }
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      });
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled request error');
    } else {
      request.log.warn({ err: error, code: error.code }, 'Request rejected');
    }

    if (
      statusCode === 413 ||
      error.code === 'FST_REQ_FILE_TOO_LARGE' ||
      error.code === 'FST_FILES_LIMIT' ||
      error.code === 'FST_PARTS_LIMIT'
    ) {
      return reply.code(413).send({
        error: {
          code: 'payload_too_large',
          message: `The request body or uploaded file exceeds the allowed size of ${deps.config.MEDIA_MAX_BYTES} bytes`
        }
      });
    }

    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: error.validation
        }
      });
    }

    return reply.code(statusCode).send({
      error: {
        code:
          statusCode >= 500 ? 'internal_error' : (error.code ?? 'request_error'),
        message:
          statusCode >= 500 ? 'An unexpected error occurred' : error.message
      }
    });
  });

  await app.register(rateLimit, {
    global: true,
    max: deps.config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) =>
      new ApiError(
        429,
        'rate_limited',
        `Rate limit exceeded: ${context.max} requests per ${context.after}. Retry later.`
      )
  });

  await app.register(cookie);

  await app.register(multipart, {
    limits: {
      fileSize: deps.config.MEDIA_MAX_BYTES,
      files: 1,
      fields: 20,
      parts: 30,
      fieldSize: 8 * 1024
    }
  });

  if (deps.config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: deps.config.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'authorization',
        'content-type',
        'x-admin-secret',
        'x-dashboard-request',
        'idempotency-key'
      ],
      maxAge: 86_400
    });
  }

  app.addHook('onRequest', async (request) => {
    request.metricsStart = Date.now();
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!deps.metrics || !request.tenant || request.metricsStart === undefined) {
      return;
    }
    deps.metrics.record(
      request.tenant.id,
      request.routeOptions.url ?? 'unknown',
      request.method,
      reply.statusCode,
      Date.now() - request.metricsStart
    );
  });

  app.get('/health', async (_request, reply) => {
    const [database, redis] = await Promise.allSettled([
      pingDb(deps.db),
      deps.redis.ping()
    ]);

    const ok = database.status === 'fulfilled' && redis.status === 'fulfilled';

    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      version: '0.1.0',
      checks: {
        database: database.status === 'fulfilled' ? 'ok' : 'unavailable',
        redis: redis.status === 'fulfilled' ? 'ok' : 'unavailable'
      },
      timestamp: new Date().toISOString()
    });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.url === '/' ||
      request.url === '/dashboard' ||
      request.url.startsWith('/dashboard/')
    ) {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('x-frame-options', 'DENY');
      reply.header('referrer-policy', 'no-referrer');
      reply.header(
        'content-security-policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      );
    }
    return payload;
  });

  app.get('/', async (_request, reply) => {
    return reply.redirect('/dashboard/');
  });

  app.get('/dashboard', async (_request, reply) => {
    return reply.redirect('/dashboard/');
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public/dashboard', import.meta.url)),
    prefix: '/dashboard/',
    index: ['index.html'],
    cacheControl: true,
    maxAge: 0
  });

  await app.register(
    async (scope) => {
      registerPublicRoutes(scope, deps);
      registerAuthRoutes(scope, deps);
    },
    { prefix: '/v1' }
  );

  await app.register(
    async (scope) => {
      scope.addHook('preHandler', createAuthenticator(deps.db));
      registerTenantRoutes(scope, deps);
      registerSessionRoutes(scope, deps);
      registerMessageRoutes(scope, deps);
      registerAnalysisRoutes(scope, deps);
      registerAnalyticsRoutes(scope, deps);
      registerGroupRoutes(scope, deps);
      registerMediaRoutes(scope, deps);
    },
    { prefix: '/v1' }
  );

  return app;
}
