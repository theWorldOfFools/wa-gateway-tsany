import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  MediaRecord,
  MessageKind,
  MessageRecord,
  WaSession
} from '../../domain.js';
import { ApiError } from '../../errors.js';
import type { MediaStorage } from '../../media/storage.js';
import { createMedia } from '../../repos/media.js';
import {
  createMessage,
  findByIdempotencyKey,
  getMessage,
  listMessages,
  updateMessageStatus
} from '../../repos/messages.js';
import { getSession } from '../../repos/sessions.js';
import { downloadToFile } from '../../security/url.js';
import { buildFallbackText, type InteractiveRequest } from '../../wa/interactive.js';
import { normalizeRecipient } from '../../wa/jid.js';
import type { HttpDeps } from '../deps.js';
import { messageDto } from '../dto.js';
import { readSingleFileMultipart } from '../multipart.js';
import { parseInput } from '../validation.js';

const RecipientSchema = z.string().trim().min(3).max(100);
const IdempotencyKeySchema = z.string().trim().min(1).max(255).optional();
const CaptionSchema = z.string().max(4_096).optional();

const TextSchema = z.object({
  to: RecipientSchema,
  text: z.string().min(1).max(65_536),
  idempotencyKey: IdempotencyKeySchema
});

const MediaJsonSchema = z.object({
  to: RecipientSchema,
  mediaUrl: z.string().trim().min(1).max(2_048),
  caption: CaptionSchema,
  fileName: z.string().trim().max(200).optional(),
  idempotencyKey: IdempotencyKeySchema
});

const MediaFieldsSchema = z.object({
  to: RecipientSchema,
  caption: CaptionSchema,
  idempotencyKey: IdempotencyKeySchema
});

const ButtonSchema = z.object({
  id: z.string().trim().min(1).max(256),
  text: z.string().trim().min(1).max(100)
});

const ListRowSchema = z.object({
  id: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional()
});

const ListSectionSchema = z.object({
  title: z.string().trim().max(120).optional(),
  rows: z.array(ListRowSchema).min(1).max(50)
});

const InteractiveBase = z.object({
  to: RecipientSchema,
  text: z.string().trim().min(1).max(4_096),
  header: z.string().trim().max(200).optional(),
  footer: z.string().trim().max(200).optional(),
  fallbackText: z.string().trim().min(1).max(4_096).optional(),
  idempotencyKey: IdempotencyKeySchema
});

const InteractiveSchema = z.discriminatedUnion('type', [
  InteractiveBase.extend({
    type: z.literal('buttons'),
    buttons: z.array(ButtonSchema).min(1).max(10)
  }),
  InteractiveBase.extend({
    type: z.literal('list'),
    buttonText: z.string().trim().min(1).max(60),
    sections: z.array(ListSectionSchema).min(1).max(10)
  })
]);

const MessageKindSchema = z.enum([
  'text',
  'image',
  'video',
  'interactive',
  'interactive_reply',
  'other'
]) satisfies z.ZodType<MessageKind>;

const ListQuerySchema = z.object({
  direction: z.enum(['in', 'out']).optional(),
  kind: MessageKindSchema.optional(),
  jid: z.string().trim().min(1).max(100).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

async function requireSession(
  deps: HttpDeps,
  tenantId: string,
  sessionId: string
): Promise<WaSession> {
  const session = await getSession(deps.db, tenantId, sessionId);
  if (!session) throw ApiError.notFound('Session not found');
  return session;
}

interface SubmitInput {
  kind: MessageKind;
  remoteJid: string;
  content: string | null;
  payload: unknown;
  mediaId?: string | null;
  idempotencyKey?: string | null;
}

interface SubmitOutcome {
  message: MessageRecord;
  statusCode: 200 | 202;
}

async function submitMessage(
  deps: HttpDeps,
  session: WaSession,
  input: SubmitInput
): Promise<SubmitOutcome> {
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(
      deps.db,
      session.id,
      input.idempotencyKey
    );
    if (existing) return resumeExisting(deps, session, existing);
  }

  const created = await createMessage(deps.db, {
    id: randomUUID(),
    tenantId: session.tenantId,
    sessionId: session.id,
    direction: 'out',
    kind: input.kind,
    status: 'queued',
    remoteJid: input.remoteJid,
    content: input.content,
    payload: input.payload,
    mediaId: input.mediaId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    meta: { source: 'api' }
  });

  if (!created.inserted) {
    return resumeExisting(deps, session, created.message);
  }

  await enqueueOrFail(deps, session, created.message);
  return { message: created.message, statusCode: 202 };
}

async function resumeExisting(
  deps: HttpDeps,
  session: WaSession,
  existing: MessageRecord
): Promise<SubmitOutcome> {
  if (
    existing.direction === 'out' &&
    (existing.status === 'queued' || existing.status === 'failed')
  ) {
    const queued =
      existing.status === 'failed'
        ? await updateMessageStatus(deps.db, existing.id, {
            status: 'queued',
            error: null
          })
        : existing;
    const message = queued ?? existing;
    await enqueueOrFail(deps, session, message);
    return { message, statusCode: 202 };
  }

  return { message: existing, statusCode: 200 };
}

async function enqueueOrFail(
  deps: HttpDeps,
  session: WaSession,
  message: MessageRecord
): Promise<void> {
  try {
    await deps.manager.enqueue(session, message.id);
  } catch (error) {
    await updateMessageStatus(deps.db, message.id, {
      status: 'failed',
      error: (error as Error).message
    }).catch(() => undefined);

    if (error instanceof ApiError) {
      throw new ApiError(error.statusCode, error.code, error.message, {
        messageId: message.id
      });
    }
    throw new ApiError(
      503,
      'enqueue_failed',
      `Could not queue the message: ${(error as Error).message}`,
      { messageId: message.id }
    );
  }
}

function sendOutcome(
  deps: HttpDeps,
  reply: FastifyReply,
  outcome: SubmitOutcome
): FastifyReply {
  return reply.code(outcome.statusCode).send({
    message: messageDto(outcome.message, deps.config.publicUrl)
  });
}

function mediaPayload(
  to: string,
  media: MediaRecord,
  caption: string | null,
  sourceUrl?: string
): Record<string, unknown> {
  return {
    to,
    mediaId: media.id,
    fileName: media.fileName,
    ...(caption ? { caption } : {}),
    ...(sourceUrl ? { sourceUrl } : {})
  };
}

async function persistMedia(
  deps: HttpDeps,
  session: WaSession,
  stored: {
    id: string;
    mimeType: string;
    sizeBytes: number;
    fileName: string | null;
    filePath: string;
  }
): Promise<MediaRecord> {
  return createMedia(deps.db, {
    id: stored.id,
    tenantId: session.tenantId,
    sessionId: session.id,
    direction: 'out',
    mimeType: stored.mimeType,
    fileName: stored.fileName,
    filePath: stored.filePath,
    sizeBytes: stored.sizeBytes
  });
}

function fileNameFromUrl(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname;
    const base = pathname.split('/').filter(Boolean).pop();
    if (!base) return null;
    return decodeURIComponent(base).slice(0, 180);
  } catch {
    return null;
  }
}

async function handleJsonMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: HttpDeps,
  session: WaSession,
  kind: 'image' | 'video'
): Promise<FastifyReply> {
  const body = parseInput(MediaJsonSchema, request.body);
  const to = normalizeRecipient(body.to);

  if (body.idempotencyKey) {
    const existing = await findByIdempotencyKey(
      deps.db,
      session.id,
      body.idempotencyKey
    );
    if (existing) {
      return sendOutcome(
        deps,
        reply,
        await resumeExisting(deps, session, existing)
      );
    }
  }

  const tempPath = deps.storage.newTempPath();
  let stored: Awaited<ReturnType<MediaStorage['saveFile']>>;
  try {
    await downloadToFile(
      body.mediaUrl,
      tempPath,
      deps.config.MEDIA_MAX_BYTES,
      {
        allowPrivate: deps.config.ALLOW_PRIVATE_MEDIA_URLS,
        timeoutMs: deps.config.WEBHOOK_TIMEOUT_MS
      }
    );
    stored = await deps.storage.saveFile(tempPath, {
      tenantId: session.tenantId,
      sessionId: session.id,
      direction: 'out',
      fileName: body.fileName ?? fileNameFromUrl(body.mediaUrl),
      expectedKind: kind
    });
  } catch (error) {
    await deps.storage.cleanupTemp(tempPath);
    throw error;
  }

  const media = await persistMedia(deps, session, stored);
  const caption = body.caption ?? null;
  const outcome = await submitMessage(deps, session, {
    kind,
    remoteJid: to,
    content: caption,
    payload: mediaPayload(to, media, caption, body.mediaUrl),
    mediaId: media.id,
    idempotencyKey: body.idempotencyKey
  });
  return sendOutcome(deps, reply, outcome);
}

async function handleMultipartMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: HttpDeps,
  session: WaSession,
  kind: 'image' | 'video'
): Promise<FastifyReply> {
  const result = await readSingleFileMultipart(request, () =>
    deps.storage.newTempPath()
  );
  if (!result.tempPath) {
    throw ApiError.badRequest('A file upload is required');
  }

  try {
    const fields = parseInput(MediaFieldsSchema, result.fields);
    const to = normalizeRecipient(fields.to);

    if (fields.idempotencyKey) {
      const existing = await findByIdempotencyKey(
        deps.db,
        session.id,
        fields.idempotencyKey
      );
      if (existing) {
        return sendOutcome(
          deps,
          reply,
          await resumeExisting(deps, session, existing)
        );
      }
    }

    const stored = await deps.storage.saveFile(result.tempPath, {
      tenantId: session.tenantId,
      sessionId: session.id,
      direction: 'out',
      fileName: result.originalFileName,
      expectedKind: kind
    });

    const media = await persistMedia(deps, session, stored);
    const caption = fields.caption ?? null;
    const outcome = await submitMessage(deps, session, {
      kind,
      remoteJid: to,
      content: caption,
      payload: mediaPayload(to, media, caption),
      mediaId: media.id,
      idempotencyKey: fields.idempotencyKey
    });
    return sendOutcome(deps, reply, outcome);
  } finally {
    await deps.storage.cleanupTemp(result.tempPath);
  }
}

export function registerMessageRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/messages/text',
    async (request, reply) => {
      const body = parseInput(TextSchema, request.body);
      const session = await requireSession(
        deps,
        request.tenant!.id,
        parseInput(IdParamsSchema, request.params).id
      );
      const to = normalizeRecipient(body.to);

      const outcome = await submitMessage(deps, session, {
        kind: 'text',
        remoteJid: to,
        content: body.text,
        payload: { to, text: body.text },
        idempotencyKey: body.idempotencyKey
      });
      return sendOutcome(deps, reply, outcome);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/sessions/:id/messages/image',
    async (request, reply) => {
      const session = await requireSession(
        deps,
        request.tenant!.id,
        parseInput(IdParamsSchema, request.params).id
      );
      if (request.isMultipart()) {
        return handleMultipartMedia(request, reply, deps, session, 'image');
      }
      return handleJsonMedia(request, reply, deps, session, 'image');
    }
  );

  app.post<{ Params: { id: string } }>(
    '/sessions/:id/messages/video',
    async (request, reply) => {
      const session = await requireSession(
        deps,
        request.tenant!.id,
        parseInput(IdParamsSchema, request.params).id
      );
      if (request.isMultipart()) {
        return handleMultipartMedia(request, reply, deps, session, 'video');
      }
      return handleJsonMedia(request, reply, deps, session, 'video');
    }
  );

  app.post<{ Params: { id: string } }>(
    '/sessions/:id/messages/interactive',
    async (request, reply) => {
      const body = parseInput(InteractiveSchema, request.body);
      const session = await requireSession(
        deps,
        request.tenant!.id,
        parseInput(IdParamsSchema, request.params).id
      );
      const to = normalizeRecipient(body.to);

      const interactive: InteractiveRequest =
        body.type === 'buttons'
          ? {
              type: 'buttons',
              text: body.text,
              header: body.header,
              footer: body.footer,
              buttons: body.buttons
            }
          : {
              type: 'list',
              text: body.text,
              header: body.header,
              footer: body.footer,
              buttonText: body.buttonText,
              sections: body.sections
            };

      const fallbackText = body.fallbackText ?? buildFallbackText(interactive);

      const outcome = await submitMessage(deps, session, {
        kind: 'interactive',
        remoteJid: to,
        content: body.text,
        payload: {
          to,
          interactive,
          fallbackText
        },
        idempotencyKey: body.idempotencyKey
      });
      return sendOutcome(deps, reply, outcome);
    }
  );

  app.get<{ Params: { id: string } }>(
    '/sessions/:id/messages',
    async (request) => {
      const query = parseInput(ListQuerySchema, request.query ?? {});
      const session = await requireSession(
        deps,
        request.tenant!.id,
        parseInput(IdParamsSchema, request.params).id
      );

      const rows = await listMessages(deps.db, session.tenantId, session.id, {
        direction: query.direction,
        kind: query.kind,
        jid: query.jid,
        before: query.before ? new Date(query.before) : undefined,
        limit: query.limit
      });

      return {
        data: rows.map((row) => messageDto(row, deps.config.publicUrl)),
        hasMore: rows.length === query.limit
      };
    }
  );

  app.get<{ Params: { id: string } }>('/messages/:id', async (request) => {
    const id = parseInput(IdParamsSchema, request.params).id;
    const message = await getMessage(deps.db, request.tenant!.id, id);
    if (!message) throw ApiError.notFound('Message not found');
    return { message: messageDto(message, deps.config.publicUrl) };
  });
}
