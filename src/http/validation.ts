import type { z } from 'zod';
import { ApiError } from '../errors.js';

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      400,
      'validation_error',
      'Request validation failed',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    );
  }
  return result.data;
}
