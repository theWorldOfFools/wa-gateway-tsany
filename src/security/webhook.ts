import { createHmac } from 'node:crypto';

export function computeWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `sha256=${digest}`;
}
