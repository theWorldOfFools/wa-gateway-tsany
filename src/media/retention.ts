import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { deleteMediaByIds, listExpiredMedia } from '../repos/media.js';
import type { MediaStorage } from './storage.js';

export async function runMediaRetention(
  db: Db,
  storage: MediaStorage,
  logger: Logger,
  retentionDays: number,
  batchSize = 200
): Promise<number> {
  if (retentionDays <= 0) return 0;

  let deleted = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    const expired = await listExpiredMedia(db, retentionDays, batchSize);
    if (expired.length === 0) break;

    for (const item of expired) {
      await storage.removeFile(item.filePath);
    }
    await deleteMediaByIds(
      db,
      expired.map((item) => item.id)
    );
    deleted += expired.length;

    if (expired.length < batchSize) break;
  }

  if (deleted > 0) {
    logger.info({ deleted, retentionDays }, 'Expired media files removed');
  }
  return deleted;
}
