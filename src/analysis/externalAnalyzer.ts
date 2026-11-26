import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { AnalysisConfigRecord, AnalysisResultData } from '../domain.js';
import { computeWebhookSignature } from '../security/webhook.js';
import { validateOutboundUrl } from '../security/url.js';

export const EXTERNAL_ANALYZER_VERSION = 'external-v1';

const ResponseSchema = z
  .object({
    label: z.enum(['positive', 'negative', 'neutral']),
    intent: z.string().trim().min(1).max(64).default('other'),
    score: z.number().min(-1).max(1).optional(),
    keywords: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    summary: z.string().max(2_000).optional(),
    analyzerVersion: z.string().max(64).optional()
  })
  .passthrough();

export interface ExternalAnalysisInput {
  tenantId: string;
  sessionId: string | null;
  messageId: string | null;
  text: string;
  config: AnalysisConfigRecord;
  globalConfig: Config;
  message?: {
    direction: string;
    kind: string;
    createdAt: Date;
    remoteJid: string;
    senderJid: string | null;
  };
}

export interface ExternalRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
  deliveryId: string;
  timestamp: string;
}

export function buildExternalAnalysisRequest(input: ExternalAnalysisInput): ExternalRequest {
  if (!input.config.endpoint) {
    throw new Error('External analyzer endpoint is not configured');
  }

  const deliveryId = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const data: Record<string, unknown> = {
    messageId: input.messageId,
    text: input.text
  };

  if (input.message) {
    data.direction = input.message.direction;
    data.kind = input.message.kind;
    data.createdAt = input.message.createdAt.toISOString();
    if (!input.config.redact) {
      data.remoteJid = input.message.remoteJid;
      data.senderJid = input.message.senderJid;
    }
  }

  const body = JSON.stringify({
    id: deliveryId,
    event: 'analysis.request',
    version: 1,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    timestamp: new Date(Number(timestamp) * 1000).toISOString(),
    data
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'wa-gateway/0.1',
    'x-wa-event': 'analysis.request',
    'x-wa-delivery': deliveryId,
    'x-wa-timestamp': timestamp
  };

  if (input.config.authMode === 'signature' && input.config.secret) {
    headers['x-wa-signature'] = computeWebhookSignature(
      input.config.secret,
      timestamp,
      body
    );
  } else if (input.config.authMode === 'bearer' && input.config.secret) {
    headers.authorization = `Bearer ${input.config.secret}`;
  }

  return {
    url: new URL(input.config.endpoint),
    headers,
    body,
    deliveryId,
    timestamp
  };
}

export interface ExternalAnalysisResponse {
  result: AnalysisResultData;
  raw: unknown;
  version: string;
}

export async function callExternalAnalyzer(
  input: ExternalAnalysisInput,
  logger?: Logger
): Promise<ExternalAnalysisResponse> {
  const request = buildExternalAnalysisRequest(input);
  const url = await validateOutboundUrl(request.url.toString(), {
    allowPrivate: input.globalConfig.ALLOW_PRIVATE_ANALYSIS_ENDPOINTS,
    timeoutMs: input.config.timeoutMs
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    redirect: 'error',
    signal: AbortSignal.timeout(input.config.timeoutMs)
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `External analyzer returned HTTP ${response.status}: ${text.slice(0, 200)}`
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('External analyzer returned invalid JSON');
  }

  const parsed = ResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`External analyzer returned an invalid result: ${issues}`);
  }

  const data = parsed.data;
  logger?.debug(
    { deliveryId: request.deliveryId, status: response.status },
    'External analysis received'
  );

  return {
    result: {
      label: data.label,
      intent: data.intent,
      score: data.score ?? 0,
      keywords: data.keywords ?? [],
      summary: data.summary ?? ''
    },
    raw: payload,
    version: data.analyzerVersion ?? EXTERNAL_ANALYZER_VERSION
  };
}
