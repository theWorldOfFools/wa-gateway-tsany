import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  downloadMediaMessage,
  getContentType,
  isJidGroup,
  isJidNewsletter,
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WASocket
} from '@whiskeysockets/baileys';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type {
  MediaRecord,
  MessageKind,
  MessageRecord,
  WaSession
} from '../domain.js';
import type { MediaStorage } from '../media/storage.js';
import { createMedia } from '../repos/media.js';
import {
  createInboundMessage,
  findByWaMessageId
} from '../repos/messages.js';
import type { WebhookDispatcher } from '../webhooks/dispatcher.js';

interface ParsedContent {
  kind: MessageKind;
  content: string | null;
  waType: string;
  payload: Record<string, unknown>;
  mediaKind?: 'image' | 'video';
}

export class InboundHandler {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly storage: MediaStorage,
    private readonly webhooks: WebhookDispatcher,
    private readonly logger: Logger
  ) {}

  async handle(
    session: Pick<WaSession, 'id' | 'tenantId'>,
    messages: WAMessage[],
    sock: WASocket
  ): Promise<void> {
    for (const message of messages) {
      try {
        await this.handleOne(session, message, sock);
      } catch (error) {
        this.logger.error(
          { error, sessionId: session.id, waMessageId: message.key?.id },
          'Failed to process incoming WhatsApp message'
        );
      }
    }
  }

  private async handleOne(
    session: Pick<WaSession, 'id' | 'tenantId'>,
    message: WAMessage,
    sock: WASocket
  ): Promise<void> {
    const key = message.key;
    const remoteJid = key?.remoteJid;
    if (!key?.id || !remoteJid) return;
    if (key.fromMe) return;
    if (!message.message) return;
    if (remoteJid === 'status@broadcast') return;
    if (isJidNewsletter(remoteJid)) return;

    const existing = await findByWaMessageId(this.db, session.id, key.id);
    if (existing) return;

    const content = normalizeMessageContent(message.message);
    if (!content) return;

    const waType = getContentType(content) ?? 'unknown';
    const parsed = parseContent(content, waType);
    const isGroup = isJidGroup(remoteJid);
    const senderJid = isGroup ? key.participant ?? null : remoteJid;

    let media: MediaRecord | null = null;
    if (parsed.mediaKind) {
      media = await this.storeIncomingMedia(
        session,
        message,
        parsed.mediaKind,
        sock
      );
      if (!media) {
        parsed.payload.mediaUnavailable = true;
      }
    }

    const record = await createInboundMessage(this.db, {
      id: randomUUID(),
      tenantId: session.tenantId,
      sessionId: session.id,
      direction: 'in',
      kind: parsed.kind,
      status: 'received',
      remoteJid,
      senderJid,
      isGroup,
      content: parsed.content,
      payload: {
        ...parsed.payload,
        waType,
        pushName: message.pushName ?? null,
        remoteJidAlt: (key as { remoteJidAlt?: string | null }).remoteJidAlt ?? null
      },
      mediaId: media?.id ?? null,
      waMessageId: key.id,
      meta: {
        waTimestamp: toIsoTimestamp(message.messageTimestamp),
        source: 'baileys'
      }
    });

    if (!record) {
      if (media) {
        await this.storage.removeFile(media.filePath);
      }
      return;
    }

    this.webhooks.emit(session.id, 'message.received', {
      ...toMessageDto(record, this.config.publicUrl),
      media: media ? toMediaDto(media, this.config.publicUrl) : null
    });
  }

  private async storeIncomingMedia(
    session: Pick<WaSession, 'id' | 'tenantId'>,
    message: WAMessage,
    kind: 'image' | 'video',
    sock: WASocket
  ): Promise<MediaRecord | null> {
    const content = message.message;
    if (!content) return null;
    const normalized = normalizeMessageContent(content);
    const mediaContent =
      kind === 'image' ? normalized?.imageMessage : normalized?.videoMessage;
    const declaredSize = toNumber(mediaContent?.fileLength);

    if (declaredSize > this.config.MEDIA_MAX_BYTES) {
      this.logger.warn(
        { sessionId: session.id, waMessageId: message.key.id, declaredSize },
        'Incoming media is larger than the configured limit; skipping download'
      );
      return null;
    }

    let buffer: Buffer;
    try {
      buffer = await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
          logger: this.logger,
          reuploadRequest: sock.updateMediaMessage
        }
      );
    } catch (error) {
      this.logger.warn(
        { sessionId: session.id, waMessageId: message.key.id, error },
        'Could not download incoming media'
      );
      return null;
    }

    if (buffer.length > this.config.MEDIA_MAX_BYTES) {
      this.logger.warn(
        { sessionId: session.id, waMessageId: message.key.id, size: buffer.length },
        'Downloaded media exceeds the configured limit; discarding'
      );
      return null;
    }

    try {
      const stored = await this.storage.saveBuffer(buffer, {
        tenantId: session.tenantId,
        sessionId: session.id,
        direction: 'in',
        fileName: null,
        expectedKind: kind,
        strict: false
      });
      return createMedia(this.db, {
        id: stored.id,
        tenantId: session.tenantId,
        sessionId: session.id,
        direction: 'in',
        mimeType: stored.mimeType,
        fileName: stored.fileName,
        filePath: stored.filePath,
        sizeBytes: stored.sizeBytes
      });
    } catch (error) {
      this.logger.warn(
        { sessionId: session.id, waMessageId: message.key.id, error },
        'Could not persist incoming media'
      );
      return null;
    }
  }
}

function parseContent(content: proto.IMessage, waType: string): ParsedContent {
  const payload: Record<string, unknown> = {};

  if (waType === 'conversation' && content.conversation) {
    return { kind: 'text', content: content.conversation, waType, payload };
  }

  if (waType === 'extendedTextMessage') {
    const text = content.extendedTextMessage?.text ?? null;
    return { kind: 'text', content: text, waType, payload };
  }

  if (waType === 'imageMessage') {
    payload.mimeType = content.imageMessage?.mimetype ?? null;
    return {
      kind: 'image',
      content: content.imageMessage?.caption ?? null,
      waType,
      payload,
      mediaKind: 'image'
    };
  }

  if (waType === 'videoMessage') {
    payload.mimeType = content.videoMessage?.mimetype ?? null;
    return {
      kind: 'video',
      content: content.videoMessage?.caption ?? null,
      waType,
      payload,
      mediaKind: 'video'
    };
  }

  if (waType === 'buttonsResponseMessage') {
    const response = content.buttonsResponseMessage;
    payload.reply = {
      type: 'buttons',
      id: response?.selectedButtonId ?? null,
      text: response?.selectedDisplayText ?? null
    };
    return {
      kind: 'interactive_reply',
      content: response?.selectedDisplayText ?? response?.selectedButtonId ?? null,
      waType,
      payload
    };
  }

  if (waType === 'listResponseMessage') {
    const response = content.listResponseMessage;
    const rowId = response?.singleSelectReply?.selectedRowId ?? null;
    payload.reply = {
      type: 'list',
      id: rowId,
      text: response?.title ?? null
    };
    return {
      kind: 'interactive_reply',
      content: response?.title ?? rowId,
      waType,
      payload
    };
  }

  if (waType === 'templateButtonReplyMessage') {
    const response = content.templateButtonReplyMessage;
    payload.reply = {
      type: 'template_button',
      id: response?.selectedId ?? null,
      text: response?.selectedDisplayText ?? null
    };
    return {
      kind: 'interactive_reply',
      content: response?.selectedDisplayText ?? response?.selectedId ?? null,
      waType,
      payload
    };
  }

  if (waType === 'interactiveResponseMessage') {
    const response = content.interactiveResponseMessage;
    const paramsJson = response?.nativeFlowResponseMessage?.paramsJson ?? null;
    let params: unknown = null;
    if (paramsJson) {
      try {
        params = JSON.parse(paramsJson);
      } catch {
        params = paramsJson;
      }
    }
    const replyId = extractReplyId(params);
    payload.reply = {
      type: 'native_flow',
      id: replyId,
      text: response?.body?.text ?? null,
      params
    };
    return {
      kind: 'interactive_reply',
      content: response?.body?.text ?? replyId,
      waType,
      payload
    };
  }

  return {
    kind: 'other',
    content: null,
    waType,
    payload
  };
}

function extractReplyId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const record = params as Record<string, unknown>;
  for (const key of ['id', 'selectedId', 'selected_id', 'button_id', 'row_id']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toNumber?: () => number }).toNumber === 'function'
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

function toIsoTimestamp(value: unknown): string | null {
  const seconds = toNumber(value);
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
}

export function toMediaDto(media: MediaRecord, publicUrl: string): Record<string, unknown> {
  const downloadPath = `/v1/media/${media.id}`;
  return {
    id: media.id,
    mimeType: media.mimeType,
    fileName: media.fileName,
    sizeBytes: media.sizeBytes,
    downloadPath,
    url: publicUrl ? `${publicUrl}${downloadPath}` : downloadPath
  };
}

export function toMessageDto(
  message: MessageRecord,
  publicUrl: string
): Record<string, unknown> {
  return {
    id: message.id,
    sessionId: message.sessionId,
    direction: message.direction,
    kind: message.kind,
    status: message.status,
    remoteJid: message.remoteJid,
    senderJid: message.senderJid,
    isGroup: message.isGroup,
    content: message.content,
    payload: message.payload,
    waMessageId: message.waMessageId,
    mediaId: message.mediaId,
    error: message.error,
    createdAt: message.createdAt.toISOString(),
    meta: message.meta,
    mediaPath: message.mediaId ? `${publicUrl}/v1/media/${message.mediaId}` : null
  };
}
