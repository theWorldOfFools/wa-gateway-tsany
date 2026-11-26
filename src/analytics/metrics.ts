import type { Db } from '../db/index.js';

interface MetricBucket {
  tenantId: string;
  bucket: number;
  route: string;
  method: string;
  statusClass: string;
  count: number;
  totalDurationMs: number;
}

const keyFor = (
  tenantId: string,
  bucket: number,
  route: string,
  method: string,
  statusClass: string
): string => `${tenantId}|${bucket}|${route}|${method}|${statusClass}`;

/** In-memory request counters flushed to PostgreSQL once per minute. */
export class ApiMetrics {
  private readonly buckets = new Map<string, MetricBucket>();

  record(
    tenantId: string,
    route: string,
    method: string,
    statusCode: number,
    durationMs: number
  ): void {
    const bucket = Math.floor(Date.now() / 60_000) * 60_000;
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const key = keyFor(tenantId, bucket, route, method, statusClass);
    const current = this.buckets.get(key);
    if (current) {
      current.count += 1;
      current.totalDurationMs += durationMs;
      return;
    }
    this.buckets.set(key, {
      tenantId,
      bucket,
      route,
      method,
      statusClass,
      count: 1,
      totalDurationMs: durationMs
    });
  }

  async flush(db: Db): Promise<number> {
    if (this.buckets.size === 0) return 0;

    const pending = [...this.buckets.values()];
    this.buckets.clear();

    let flushed = 0;
    try {
      for (const item of pending) {
        await db.query(
          `INSERT INTO api_metrics_minute (
             tenant_id, bucket, route, method, status_class,
             request_count, total_duration_ms
           )
           VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, bucket, route, method, status_class)
           DO UPDATE SET
             request_count = api_metrics_minute.request_count + EXCLUDED.request_count,
             total_duration_ms = api_metrics_minute.total_duration_ms + EXCLUDED.total_duration_ms`,
          [
            item.tenantId,
            item.bucket / 1000,
            item.route,
            item.method,
            item.statusClass,
            item.count,
            item.totalDurationMs
          ]
        );
        flushed += 1;
      }
    } catch (error) {
      for (const item of pending.slice(flushed)) {
        const key = keyFor(
          item.tenantId,
          item.bucket,
          item.route,
          item.method,
          item.statusClass
        );
        this.buckets.set(key, item);
      }
      throw error;
    }
    return flushed;
  }
}
