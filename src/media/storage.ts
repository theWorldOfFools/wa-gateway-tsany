import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
import type { Config } from '../config.js';
import type { MessageDirection } from '../domain.js';
import { ApiError } from '../errors.js';

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/3gpp',
  'video/webm',
  'video/quicktime'
]);

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
};

export interface SaveMediaOptions {
  tenantId: string;
  sessionId: string | null;
  direction: MessageDirection;
  fileName?: string | null;
  expectedKind?: 'image' | 'video';
  strict?: boolean;
}

export interface StoredMediaFile {
  id: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
}

function sanitizeFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const base = path.basename(fileName).replace(/[^\w.\- ()]+/g, '_');
  return base.slice(0, 180) || null;
}

export class MediaStorage {
  constructor(private readonly config: Config) {}

  async init(): Promise<void> {
    await fs.mkdir(this.config.mediaDir, { recursive: true });
    await fs.mkdir(this.config.tmpDir, { recursive: true });
    await fs.mkdir(this.config.authDir, { recursive: true });
  }

  newTempPath(): string {
    return path.join(this.config.tmpDir, `${randomUUID()}.upload`);
  }

  async cleanupTemp(tempPath: string): Promise<void> {
    await fs.unlink(tempPath).catch(() => undefined);
  }

  async saveFile(tempPath: string, options: SaveMediaOptions): Promise<StoredMediaFile> {
    const stat = await fs.stat(tempPath);
    if (stat.size <= 0) {
      await this.cleanupTemp(tempPath);
      throw ApiError.badRequest('Uploaded media file is empty');
    }
    if (stat.size > this.config.MEDIA_MAX_BYTES) {
      await this.cleanupTemp(tempPath);
      throw ApiError.tooLarge(
        `Media exceeds the maximum allowed size of ${this.config.MEDIA_MAX_BYTES} bytes`
      );
    }

    const detected = await fileTypeFromFile(tempPath).catch(() => undefined);
    return this.finalize(tempPath, detected?.mime, detected?.ext, stat.size, options);
  }

  async saveBuffer(buffer: Buffer, options: SaveMediaOptions): Promise<StoredMediaFile> {
    const tempPath = this.newTempPath();
    await fs.writeFile(tempPath, buffer);
    const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
    return this.finalize(tempPath, detected?.mime, detected?.ext, buffer.length, options);
  }

  private async finalize(
    tempPath: string,
    detectedMime: string | undefined,
    detectedExt: string | undefined,
    sizeBytes: number,
    options: SaveMediaOptions
  ): Promise<StoredMediaFile> {
    const strict = options.strict ?? true;

    if (options.expectedKind === 'image') {
      if (!detectedMime || !IMAGE_MIME_TYPES.has(detectedMime)) {
        await this.cleanupTemp(tempPath);
        if (strict) {
          throw ApiError.unprocessable(
            'unsupported_media_type',
            'File is not a supported image (jpeg, png, webp or gif)'
          );
        }
      }
    }

    if (options.expectedKind === 'video') {
      if (!detectedMime || !VIDEO_MIME_TYPES.has(detectedMime)) {
        await this.cleanupTemp(tempPath);
        if (strict) {
          throw ApiError.unprocessable(
            'unsupported_media_type',
            'File is not a supported video (mp4, 3gp, webm or mov)'
          );
        }
      }
    }

    const mimeType = detectedMime ?? 'application/octet-stream';
    const extension = detectedExt ?? EXTENSION_BY_MIME[mimeType] ?? 'bin';
    if (strict && extension === 'bin') {
      await this.cleanupTemp(tempPath);
      throw ApiError.unprocessable(
        'unsupported_media_type',
        'Could not determine the uploaded file type'
      );
    }

    const id = randomUUID();
    const tenantDir = path.join(this.config.mediaDir, options.tenantId);
    await fs.mkdir(tenantDir, { recursive: true });
    const finalPath = path.join(tenantDir, `${id}.${extension}`);

    try {
      await fs.rename(tempPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        await fs.copyFile(tempPath, finalPath);
        await this.cleanupTemp(tempPath);
      } else {
        await this.cleanupTemp(tempPath);
        throw error;
      }
    }

    return {
      id,
      filePath: finalPath,
      mimeType,
      sizeBytes,
      fileName: sanitizeFileName(options.fileName)
    };
  }

  async removeFile(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => undefined);
  }

  async removeSessionDirectory(tenantId: string): Promise<void> {
    // Media files are stored per tenant, not per session. Individual files are
    // removed by the caller using their recorded paths.
    await fs.mkdir(path.join(this.config.mediaDir, tenantId), { recursive: true });
  }

  async removeAuthState(sessionId: string): Promise<void> {
    await fs.rm(path.join(this.config.authDir, sessionId), {
      recursive: true,
      force: true
    });
  }
}
