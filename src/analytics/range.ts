import { ApiError } from '../errors.js';

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 90;

export function resolveTimeRange(from?: string, to?: string): {
  from: Date;
  to: Date;
} {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - 7 * DAY_MS);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw ApiError.badRequest('Invalid time range');
  }
  if (fromDate.getTime() > toDate.getTime()) {
    throw ApiError.badRequest('The start time must be before the end time');
  }
  if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw ApiError.badRequest(
      `Time range cannot exceed ${MAX_RANGE_DAYS} days`
    );
  }

  return { from: fromDate, to: toDate };
}
