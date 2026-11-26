import type {
  AnalysisConfigRecord,
  ApiKeyRecord,
  MessageAnalysisRecord,
  MessageRecord,
  WaSession
} from '../domain.js';
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

export function analysisConfigDto(
  config: AnalysisConfigRecord
): Record<string, unknown> {
  return {
    enabled: config.enabled,
    mode: config.mode,
    endpoint: config.endpoint,
    authMode: config.authMode,
    redact: config.redact,
    maxChars: config.maxChars,
    timeoutMs: config.timeoutMs,
    hasSecret: Boolean(config.secret),
    secretHint: config.secret ? `••••${config.secret.slice(-4)}` : null,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString()
  };
}

export function analysisDto(
  record: MessageAnalysisRecord
): Record<string, unknown> {
  return {
    id: record.id,
    messageId: record.messageId,
    sessionId: record.sessionId,
    source: record.source,
    status: record.status,
    result: record.result,
    raw: record.raw,
    error: record.error,
    durationMs: record.durationMs,
    analyzerVersion: record.analyzerVersion,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  };
}
