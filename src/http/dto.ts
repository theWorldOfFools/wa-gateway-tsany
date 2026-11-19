import type { ApiKeyRecord, MessageRecord, WaSession } from '../domain.js';
import { toMessageDto } from '../wa/inbound.js';

export function apiKeyDto(key: ApiKeyRecord): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    prefix: key.keyPrefix,
    scopes: key.scopes,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null
  };
}

export function sessionDto(session: WaSession): Record<string, unknown> {
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    phoneNumber: session.phoneNumber,
    jid: session.jid,
    lastError: session.lastError,
    qrAvailable: Boolean(session.qr),
    webhook: {
      url: session.webhookUrl,
      events: session.webhookEvents,
      interactiveFallback: session.interactiveFallback,
      hasSecret: Boolean(session.webhookSecret),
      secretHint: session.webhookSecret
        ? `••••${session.webhookSecret.slice(-4)}`
        : null
    },
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

export function messageDto(
  message: MessageRecord,
  publicUrl: string
): Record<string, unknown> {
  return toMessageDto(message, publicUrl);
}
