import type { Logger } from 'pino';
import type { Db } from '../db/index.js';

/** Removes analysis results and delivery metrics older than the retention window. */
export async function runAnalysisRetention(
  db: Db,
  logger: Logger,
  retentionDays: number
): Promise<number> {
  if (retentionDays <= 0) return 0;

  const tables = [
    'message_analysis',
    'webhook_deliveries',
    'api_metrics_minute'
  ];

  let deleted = 0;
  for (const table of tables) {
    const column = table === 'api_metrics_minute' ? 'bucket' : 'created_at';
    const result = await db.query<{ count: string }>(
      `WITH removed AS (
         DELETE FROM ${table}
         WHERE ${column} < now() - make_interval(days => $1::int)
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM removed`,
      [retentionDays]
    );
    deleted += Number(result.rows[0]?.count ?? 0);
  }

  if (deleted > 0) {
    logger.info({ deleted, retentionDays }, 'Expired analysis data removed');
  }
  return deleted;
}
