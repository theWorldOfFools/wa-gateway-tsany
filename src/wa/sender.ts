import { createReadStream } from 'node:fs';
import type { Logger } from 'pino';
import {
  generateWAMessageFromContent,
  isJidGroup,
  proto,
  type BinaryNode,
  type WASocket
} from '@whiskeysockets/baileys';
import type { Db } from '../db/index.js';
import type { MessageRecord, WaSession } from '../domain.js';
import { ApiError } from '../errors.js';
import { getMedia } from '../repos/media.js';
import type { MediaStorage } from '../media/storage.js';
import {
  buildFallbackText,
  buildInteractiveEnvelope,
  buildListMessage,
  buildMixedNativeFlowBizNode,
  buildProductListBizNode,
  type InteractiveRequest
} from './interactive.js';

export interface OutboundPayload {
  to: string;
  text?: string;
  caption?: string;
  mediaId?: string;
  interactive?: InteractiveRequest;
  fallbackText?: string;
}

export interface SendResult {
  waMessageId: string;
  meta: Record<string, unknown>;
}

export class MessageSender {
  constructor(
    private readonly db: Db,
    private readonly storage: MediaStorage,
    private readonly logger: Logger
  ) {}

  async send(
    session: WaSession,
    message: MessageRecord,
    sock: WASocket
  ): Promise<SendResult> {
    const payload = message.payload as OutboundPayload | null;
    if (!payload?.to) {
      throw ApiError.unprocessable(
        'invalid_message_payload',
        'Stored outbound message has no recipient'
      );
    }

    if (message.kind === 'text') {
      const text = payload.text ?? message.content ?? '';
      if (!text) {
        throw ApiError.unprocessable('invalid_message_payload', 'Text message is empty');
      }
      const sent = await sock.sendMessage(payload.to, { text });
      return {
        waMessageId: requireMessageId(sent),
        meta: { renderedAs: 'text' }
      };
    }

    if (message.kind === 'image' || message.kind === 'video') {
      if (!payload.mediaId) {
        throw ApiError.unprocessable(
          'invalid_message_payload',
          'Media message has no media reference'
        );
      }
      const media = await getMedia(this.db, session.tenantId, payload.mediaId);
      if (!media || media.sessionId !== session.id) {
        throw ApiError.unprocessable('media_not_found', 'Referenced media was not found');
      }

      const stream = createReadStream(media.filePath);
      const caption = payload.caption ?? undefined;

      try {
        const sent =
          message.kind === 'image'
            ? await sock.sendMessage(payload.to, {
                image: { stream },
                caption,
                mimetype: media.mimeType
              })
            : await sock.sendMessage(payload.to, {
                video: { stream },
                caption,
                mimetype: media.mimeType
              });
        return {
          waMessageId: requireMessageId(sent),
          meta: { renderedAs: message.kind }
        };
      } finally {
        stream.destroy();
      }
    }

    if (message.kind === 'interactive') {
      if (!payload.interactive) {
        throw ApiError.unprocessable(
          'invalid_message_payload',
          'Interactive message has no button or list definition'
        );
      }

      try {
        const result = await this.sendInteractive(session, message, payload, sock);
        return result;
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (
          session.interactiveFallback &&
          payload.fallbackText &&
          payload.fallbackText.length > 0
        ) {
          this.logger.warn(
            { sessionId: session.id, messageId: message.id, error: errorMessage },
            'Interactive message failed; sending text fallback'
          );
          const sent = await sock.sendMessage(payload.to, {
            text: payload.fallbackText
          });
          return {
            waMessageId: requireMessageId(sent),
            meta: {
              renderedAs: 'text_fallback',
              interactiveType: payload.interactive.type,
              interactiveError: errorMessage
            }
          };
        }
        throw error;
      }
    }

    throw ApiError.unprocessable(
      'unsupported_message_kind',
      `Messages of kind ${message.kind} cannot be sent`
    );
  }

  private async sendInteractive(
    session: WaSession,
    message: MessageRecord,
    payload: OutboundPayload,
    sock: WASocket
  ): Promise<SendResult> {
    const userJid = sock.user?.id;
    if (!userJid) {
      throw new Error('Socket has no authenticated user');
    }

    const interactive = payload.interactive as InteractiveRequest;
    const isList = interactive.type === 'list';
    const waMessage = generateWAMessageFromContent(
      payload.to,
      isList
        ? buildListMessage(interactive)
        : buildInteractiveEnvelope(interactive),
      { userJid }
    );
    if (!waMessage.key.id || !waMessage.message) {
      throw new Error('Failed to build interactive WhatsApp message');
    }

    const botNode: BinaryNode = { tag: 'bot', attrs: { biz_bot: '1' } };
    const additionalNodes: BinaryNode[] = isList
      ? [buildProductListBizNode()]
      : isJidGroup(payload.to)
        ? [buildMixedNativeFlowBizNode()]
        : [buildMixedNativeFlowBizNode(), botNode];

    await sock.relayMessage(payload.to, waMessage.message, {
      messageId: waMessage.key.id,
      additionalNodes
    });

    this.logger.info(
      {
        sessionId: session.id,
        messageId: message.id,
        interactiveType: interactive.type,
        waMessageId: waMessage.key.id
      },
      'Interactive message relayed'
    );

    return {
      waMessageId: waMessage.key.id,
      meta: {
        renderedAs: 'interactive',
        interactiveType: interactive.type
      }
    };
  }
}

/**
 * Rebuilds the content of an outbound message so Baileys can answer
 * decryption retry requests. Without this, recipients keep showing
 * "Waiting for this message..." instead of the actual message.
 */
export function buildSentMessageContent(
  message: MessageRecord
): proto.Message | undefined {
  if (message.direction !== 'out') return undefined;

  const payload = message.payload as OutboundPayload | null;
  if (!payload) return undefined;

  if (message.kind === 'text') {
    const text = payload.text ?? message.content ?? '';
    return text ? proto.Message.fromObject({ conversation: text }) : undefined;
  }

  if (message.kind === 'interactive' && payload.interactive) {
    const interactive = payload.interactive as InteractiveRequest;
    return proto.Message.fromObject(
      interactive.type === 'list'
        ? buildListMessage(interactive)
        : buildInteractiveEnvelope(interactive)
    );
  }

  // Media content needs the original bytes/stream; it cannot be rebuilt
  // from the stored record alone.
  return undefined;
}

function requireMessageId(
  message: { key: { id?: string | null } } | undefined
): string {
  if (!message?.key.id) {
    throw new Error('WhatsApp did not return a message id');
  }
  return message.key.id;
}
