import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Logger } from 'pino';

export function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }

  const dbFromPath =
    parsed.pathname && parsed.pathname !== '/'
      ? Number.parseInt(parsed.pathname.slice(1), 10)
      : 0;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isInteger(dbFromPath) ? dbFromPath : 0,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null
  } as ConnectionOptions;
}

export class SessionQueue {
  private readonly queue: Queue<{ messageId: string }>;
  private readonly worker: Worker<{ messageId: string }>;

  constructor(
    sessionId: string,
    redisUrl: string,
    processor: (messageId: string) => Promise<void>,
    sendIntervalMs: number,
    private readonly logger: Logger,
    onFinalFailure: (messageId: string, error: Error) => Promise<void>
  ) {
    const connection = redisConnectionFromUrl(redisUrl);
    const queueName = `wa-outbound-${sessionId}`;

    this.queue = new Queue<{ messageId: string }>(queueName, { connection });
    this.worker = new Worker<{ messageId: string }>(
      queueName,
      async (job) => {
        await processor(job.data.messageId);
      },
      {
        connection,
        concurrency: 1,
        limiter: { max: 1, duration: sendIntervalMs }
      }
    );

    this.worker.on('failed', (job, error) => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      const attemptsMade = job.attemptsMade;
      this.logger.warn(
        { sessionId, messageId: job.data.messageId, attemptsMade, attempts, error: error.message },
        'Outbound message job failed'
      );
      if (attemptsMade >= attempts) {
        void onFinalFailure(job.data.messageId, error).catch((failureError) => {
          this.logger.error(
            { sessionId, messageId: job.data.messageId, failureError },
            'Failed to record final outbound message failure'
          );
        });
      }
    });

    this.worker.on('error', (error) => {
      this.logger.error({ sessionId, error }, 'Outbound worker error');
    });

    this.queue.on('error', (error) => {
      this.logger.error({ sessionId, error }, 'Outbound queue error');
    });
  }

  async enqueue(messageId: string): Promise<void> {
    const existing = await this.queue.getJob(messageId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') {
        await existing.remove();
      } else {
        // The message already has an active, waiting or completed job.
        return;
      }
    }

    await this.queue.add(
      'send',
      { messageId },
      {
        jobId: messageId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 1_000 }
      }
    );
  }

  async close(destroyJobs = false): Promise<void> {
    await this.worker.close();
    if (destroyJobs) {
      await this.queue.obliterate({ force: true }).catch((error) => {
        this.logger.warn({ error }, 'Could not obliterate outbound queue');
      });
    }
    await this.queue.close();
  }
}

export type OutboundJob = Job<{ messageId: string }>;
