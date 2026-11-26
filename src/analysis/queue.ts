import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';
import { redisConnectionFromUrl } from '../queue/sessionQueue.js';
import type { AnalysisService } from './service.js';

export class AnalysisQueue {
  private readonly queue: Queue<{ messageId: string }>;
  private readonly worker: Worker<{ messageId: string }, void>;

  constructor(
    redisUrl: string,
    concurrency: number,
    service: AnalysisService,
    private readonly logger: Logger
  ) {
    const connection = redisConnectionFromUrl(redisUrl) as ConnectionOptions;
    const queueName = 'wa-analysis';

    this.queue = new Queue<{ messageId: string }>(queueName, { connection });
    this.worker = new Worker<{ messageId: string }, void>(
      queueName,
      async (job) => {
        await service.analyzeMessage(job.data.messageId);
      },
      { connection, concurrency }
    );

    this.worker.on('failed', (job, error) => {
      if (!job) return;
      this.logger.warn(
        { messageId: job.data.messageId, error: error.message },
        'Analysis job failed'
      );
    });
    this.worker.on('error', (error) => {
      this.logger.error({ error }, 'Analysis worker error');
    });
    this.queue.on('error', (error) => {
      this.logger.error({ error }, 'Analysis queue error');
    });
  }

  async enqueue(messageId: string): Promise<void> {
    await this.queue.add(
      'analyze',
      { messageId },
      {
        // No fixed jobId: a failed job must not block re-analysis, and the
        // database upsert already prevents duplicate result rows.
        attempts: 1,
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 1_000 }
      }
    );
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}
