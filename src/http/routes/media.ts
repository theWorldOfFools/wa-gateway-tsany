import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { getMedia } from '../../repos/media.js';
import type { HttpDeps } from '../deps.js';
import { parseInput } from '../validation.js';

const ParamsSchema = z.object({ id: z.string().min(1) });

function contentDisposition(fileName: string | null): string {
  if (!fileName) return 'inline';
  const fallback = fileName.replace(/[^\w.\- ()]+/g, '_');
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function registerMediaRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.get<{ Params: { id: string } }>('/media/:id', async (request, reply) => {
    const { id } = parseInput(ParamsSchema, request.params);
    const media = await getMedia(deps.db, request.tenant!.id, id);
    if (!media) throw ApiError.notFound('Media not found');

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(media.filePath);
    } catch {
      throw ApiError.notFound('Media file is no longer available');
    }
    if (!fileStat.isFile()) {
      throw ApiError.notFound('Media file is no longer available');
    }

    return reply
      .header('cache-control', 'private, max-age=3600')
      .header('content-type', media.mimeType)
      .header('content-length', String(fileStat.size))
      .header('content-disposition', contentDisposition(media.fileName))
      .send(createReadStream(media.filePath));
  });
}
