import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';

export interface MultipartResult {
  fields: Record<string, string>;
  tempPath: string | null;
  originalFileName: string | null;
}

export async function readSingleFileMultipart(
  request: FastifyRequest,
  tempPathFactory: () => string
): Promise<MultipartResult> {
  const fields: Record<string, string> = {};
  let tempPath: string | null = null;
  let originalFileName: string | null = null;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (tempPath) {
          await part.file.resume();
          throw ApiError.badRequest('Only one file can be uploaded per request');
        }
        tempPath = tempPathFactory();
        originalFileName = part.filename ?? null;
        await pipeline(part.file, createWriteStream(tempPath, { flags: 'wx' }));
        if (part.file.truncated) {
          throw ApiError.tooLarge('Uploaded file exceeds the maximum allowed size');
        }
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (error) {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }

  if (!tempPath) {
    throw ApiError.badRequest('A file upload is required (multipart field "file")');
  }

  return { fields, tempPath, originalFileName };
}
