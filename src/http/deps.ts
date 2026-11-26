import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AnalysisQueue } from '../analysis/queue.js';
import type { AnalysisService } from '../analysis/service.js';
import type { ApiMetrics } from '../analytics/metrics.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { MediaStorage } from '../media/storage.js';
import type { SessionManager } from '../wa/sessionManager.js';

export interface HttpDeps {
  config: Config;
  db: Db;
  redis: Redis;
  logger: Logger;
  storage: MediaStorage;
  manager: SessionManager;
  analysis?: AnalysisService;
  analysisQueue?: AnalysisQueue;
  metrics?: ApiMetrics;
}
