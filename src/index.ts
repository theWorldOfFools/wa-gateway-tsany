import 'dotenv/config';
import type { FastifyInstance } from 'fastify';
import { Redis as RedisClient } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, pingDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';
import { runMediaRetention } from './media/retention.js';
import { MediaStorage } from './media/storage.js';
import { InboundHandler } from './wa/inbound.js';
import { MessageSender } from './wa/sender.js';
import { SessionManager } from './wa/sessionManager.js';
import { WebhookDispatcher } from './webhooks/dispatcher.js';

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createPool(config);
  const redis = new RedisClient(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true
  });
  const storage = new MediaStorage(config);

  let app: FastifyInstance | null = null;
  let manager: SessionManager | null = null;

  try {
    await storage.init();
    await pingDb(db);

    await redis.connect();
    await redis.ping();

    if (config.AUTO_MIGRATE) {
      const applied = await runMigrations(db);
      logger.info(
        { applied },
        applied.length
          ? 'Database migrations applied'
          : 'Database schema is up to date'
      );
    }

    const webhooks = new WebhookDispatcher(
      db,
      config,
      logger.child({ module: 'webhooks' })
    );
    const sender = new MessageSender(
      db,
      storage,
      logger.child({ module: 'sender' })
    );
    const inbound = new InboundHandler(
      db,
      config,
      storage,
      webhooks,
      logger.child({ module: 'inbound' })
    );
    manager = new SessionManager({
      config,
      db,
      logger: logger.child({ module: 'sessions' }),
      storage,
      webhooks,
      sender,
      inbound
    });

    app = await buildApp({
      config,
      db,
      redis,
      logger,
      storage,
      manager
    });
    await app.listen({ host: config.HOST, port: config.PORT });

    logger.info(
      {
        host: config.HOST,
        port: config.PORT,
        publicUrl: config.publicUrl || null,
        publicSignup: config.PUBLIC_SIGNUP
      },
      'WhatsApp gateway is listening'
    );

    const sessionManager = manager;
    void sessionManager.restore().catch((error) => {
      logger.error({ err: error }, 'Failed to restore WhatsApp sessions');
    });

    const retention = (): void => {
      void runMediaRetention(
        db,
        storage,
        logger.child({ module: 'retention' }),
        config.MEDIA_RETENTION_DAYS
      ).catch((error) => {
        logger.error({ err: error }, 'Media retention run failed');
      });
    };
    setTimeout(retention, 15_000).unref();
    const retentionTimer = setInterval(retention, RETENTION_INTERVAL_MS);
    retentionTimer.unref();

    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      logger.info({ signal }, 'Shutting down');

      const forced = setTimeout(() => {
        logger.error('Graceful shutdown timed out; forcing exit');
        process.exit(1);
      }, 20_000);
      forced.unref();

      clearInterval(retentionTimer);
      await app?.close().catch((error) => {
        logger.warn({ err: error }, 'Error while closing the HTTP server');
      });
      await manager?.shutdown().catch((error) => {
        logger.warn({ err: error }, 'Error while shutting down sessions');
      });
      await redis.quit().catch(() => undefined);
      await db.end().catch(() => undefined);

      clearTimeout(forced);
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
      logger.error({ err: reason }, 'Unhandled promise rejection');
    });
    process.on('uncaughtException', (error) => {
      logger.fatal({ err: error }, 'Uncaught exception');
      void shutdown('uncaughtException');
    });
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start the WhatsApp gateway');
    await app?.close().catch(() => undefined);
    await manager?.shutdown().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await db.end().catch(() => undefined);
    process.exitCode = 1;
  }
}

void main();
