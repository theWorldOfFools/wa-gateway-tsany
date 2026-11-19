import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import {
  getSession,
  listSessions,
  updateSessionWebhook
} from '../../repos/sessions.js';
import { validateOutboundUrl } from '../../security/url.js';
import { WEBHOOK_EVENTS } from '../../webhooks/dispatcher.js';
import type { HttpDeps } from '../deps.js';
import { sessionDto } from '../dto.js';
import { parseInput } from '../validation.js';

const CreateSessionSchema = z.object({
  name: z.string().trim().min(1).max(80)
});

const PairingCodeSchema = z.object({
  phoneNumber: z
    .string()
    .trim()
    .min(7)
    .max(24)
    .transform((value) => value.replace(/\D/g, ''))
    .refine((value) => /^\d{7,15}$/.test(value), {
      message: 'phoneNumber must contain 7 to 15 digits'
    })
});

const WebhookSchema = z.object({
  url: z.string().trim().max(2_000).nullable(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).optional(),
  interactiveFallback: z.boolean().optional(),
  rotateSecret: z.boolean().optional()
});

const SessionParamsSchema = z.object({
  id: z.string().min(1)
});

function sessionIdFrom(params: unknown): string {
  return parseInput(SessionParamsSchema, params).id;
}

async function requireSession(
  deps: HttpDeps,
  tenantId: string,
  sessionId: string
) {
  const session = await getSession(deps.db, tenantId, sessionId);
  if (!session) throw ApiError.notFound('Session not found');
  return session;
}

function webhookDto(session: {
  webhookUrl: string | null;
  webhookEvents: string[];
  webhookSecret: string | null;
  interactiveFallback: boolean;
}): Record<string, unknown> {
  return {
    url: session.webhookUrl,
    events: session.webhookEvents,
    interactiveFallback: session.interactiveFallback,
    hasSecret: Boolean(session.webhookSecret),
    secretHint: session.webhookSecret
      ? `••••${session.webhookSecret.slice(-4)}`
      : null
  };
}

export function registerSessionRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/sessions', async (request, reply) => {
    const body = parseInput(CreateSessionSchema, request.body);
    const session = await deps.manager.create(request.tenant!.id, body.name);
    return reply.code(201).send({ session: sessionDto(session) });
  });

  app.get('/sessions', async (request) => {
    const sessions = await listSessions(deps.db, request.tenant!.id);
    return { data: sessions.map(sessionDto) };
  });

  app.get<{ Params: { id: string } }>('/sessions/:id', async (request) => {
    const session = await requireSession(
      deps,
      request.tenant!.id,
      sessionIdFrom(request.params)
    );
    return { session: sessionDto(session) };
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/qr', async (request) => {
    const session = await requireSession(
      deps,
      request.tenant!.id,
      sessionIdFrom(request.params)
    );

    if (!session.qr) {
      throw new ApiError(
        409,
        'qr_unavailable',
        `No QR code is available. Current session status is "${session.status}".`,
        { status: session.status }
      );
    }

    let dataUrl: string;
    try {
      dataUrl = await QRCode.toDataURL(session.qr, {
        margin: 1,
        width: 320,
        errorCorrectionLevel: 'M'
      });
    } catch {
      throw new ApiError(502, 'qr_render_failed', 'Could not render the QR code');
    }

    return {
      sessionId: session.id,
      status: session.status,
      qr: session.qr,
      dataUrl,
      updatedAt: session.qrUpdatedAt?.toISOString() ?? null
    };
  });

  app.post<{ Params: { id: string } }>(
    '/sessions/:id/pairing-code',
    async (request) => {
      const body = parseInput(PairingCodeSchema, request.body);
      const session = await requireSession(
        deps,
        request.tenant!.id,
        sessionIdFrom(request.params)
      );

      if (session.status === 'connected') {
        throw ApiError.conflict(
          'session_already_connected',
          'This session is already connected to WhatsApp'
        );
      }

      const code = await deps.manager.requestPairingCode(
        session,
        body.phoneNumber
      );

      return {
        sessionId: session.id,
        pairingCode: code,
        phoneNumber: body.phoneNumber,
        instructions:
          'On the WhatsApp phone, open Settings > Linked devices > Link a device > Link with phone number instead, then enter this code.'
      };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/sessions/:id/reconnect',
    async (request) => {
      const session = await requireSession(
        deps,
        request.tenant!.id,
        sessionIdFrom(request.params)
      );
      if (session.status === 'connected') {
        return { session: sessionDto(session), reconnected: false };
      }
      const reconnected = await deps.manager.reconnect(session);
      return { session: sessionDto(reconnected), reconnected: true };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/sessions/:id/logout',
    async (request) => {
      const session = await requireSession(
        deps,
        request.tenant!.id,
        sessionIdFrom(request.params)
      );
      await deps.manager.logout(session);
      const refreshed = await requireSession(
        deps,
        request.tenant!.id,
        session.id
      );
      return { session: sessionDto(refreshed) };
    }
  );

  app.delete<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    const session = await requireSession(
      deps,
      request.tenant!.id,
      sessionIdFrom(request.params)
    );
    await deps.manager.remove(session);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>(
    '/sessions/:id/webhook',
    async (request) => {
      const session = await requireSession(
        deps,
        request.tenant!.id,
        sessionIdFrom(request.params)
      );
      return { webhook: webhookDto(session) };
    }
  );

  app.put<{ Params: { id: string } }>(
    '/sessions/:id/webhook',
    async (request) => {
      const body = parseInput(WebhookSchema, request.body);
      const session = await requireSession(
        deps,
        request.tenant!.id,
        sessionIdFrom(request.params)
      );

      if (body.url) {
        await validateOutboundUrl(body.url, {
          allowPrivate: deps.config.ALLOW_PRIVATE_WEBHOOKS
        });
      }

      const revealSecret = Boolean(
        body.url && (body.rotateSecret || !session.webhookSecret)
      );
      const secret = !body.url
        ? null
        : revealSecret
          ? `whsec_${randomBytes(24).toString('base64url')}`
          : session.webhookSecret;

      await updateSessionWebhook(deps.db, session.id, {
        url: body.url,
        secret,
        events: body.events ?? (body.url ? session.webhookEvents : []),
        interactiveFallback:
          body.interactiveFallback ?? session.interactiveFallback
      });

      const refreshed = await requireSession(
        deps,
        request.tenant!.id,
        session.id
      );

      return {
        webhook: webhookDto(refreshed),
        secret: revealSecret ? secret : undefined,
        warning: revealSecret
          ? 'Store the webhook secret securely. It is only returned when it is created or rotated.'
          : undefined
      };
    }
  );
}
