import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { getSessionById } from '../repos/sessions.js';
import { validateOutboundUrl } from '../security/url.js';
import { computeWebhookSignature } from '../security/webhook.js';

export const WEBHOOK_EVENTS = [
  'session.qr',
  'session.connected',
  'session.disconnected',
  'session.logged_out',
  'message.received',
  'message.status'
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const RETRY_DELAYS_MS = [1_000, 3_000, 7_000];

export class WebhookDispatcher {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly logger: Logger
  ) {}

  emit(sessionId: string, event: WebhookEvent, data: unknown): void {
    void this.deliver(sessionId, event, data).catch((error) => {
      this.logger.error(
        { error, sessionId, event },
        'Unexpected error while dispatching webhook'
      );
    });
  }

  private async deliver(sessionId: string, event: WebhookEvent, data: unknown): Promise<void> {
    const session = await getSessionById(this.db, sessionId);
    if (!session?.webhookUrl) return;
    if (!session.webhookEvents.includes(event)) return;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = {
      id: randomUUID(),
      event,
      version: 1,
      tenantId: session.tenantId,
      sessionId: session.id,
      timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      data
    };
    const rawBody = JSON.stringify(payload);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'wa-gateway/0.1',
      'x-wa-event': event,
      'x-wa-delivery': payload.id,
      'x-wa-timestamp': timestamp
    };
    if (session.webhookSecret) {
      headers['x-wa-signature'] = computeWebhookSignature(
        session.webhookSecret,
        timestamp,
        rawBody
      );
    }

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const url = await validateOutboundUrl(session.webhookUrl, {
          allowPrivate: this.config.ALLOW_PRIVATE_WEBHOOKS,
          timeoutMs: this.config.WEBHOOK_TIMEOUT_MS
        });
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: rawBody,
          redirect: 'error',
          signal: AbortSignal.timeout(this.config.WEBHOOK_TIMEOUT_MS)
        });
        await response.body?.cancel();

        if (response.ok) return;

        this.logger.warn(
          {
            sessionId,
            event,
            status: response.status,
            attempt: attempt + 1
          },
          'Webhook endpoint returned a non-2xx response'
        );
      } catch (error) {
        this.logger.warn(
          { sessionId, event, attempt: attempt + 1, error: (error as Error).message },
          'Webhook delivery attempt failed'
        );
      }

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.logger.error({ sessionId, event }, 'Webhook delivery failed after all retries');
  }
}
