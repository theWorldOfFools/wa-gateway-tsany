import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { WaSession } from '../domain.js';
import { ApiError } from '../errors.js';
import type { MediaStorage } from '../media/storage.js';
import { deleteMediaForSession, listMediaForSession } from '../repos/media.js';
import {
  countAllSessions,
  countSessionsForTenant,
  createSession,
  deleteSession,
  getSessionById,
  listAllSessions,
  updateSessionState
} from '../repos/sessions.js';
import type { WebhookDispatcher } from '../webhooks/dispatcher.js';
import type { InboundHandler } from './inbound.js';
import type { MessageSender } from './sender.js';
import { SessionRuntime } from './sessionRuntime.js';

export interface SessionManagerDeps {
  config: Config;
  db: Db;
  logger: Logger;
  storage: MediaStorage;
  webhooks: WebhookDispatcher;
  sender: MessageSender;
  inbound: InboundHandler;
}

export class SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>();

  constructor(private readonly deps: SessionManagerDeps) {}

  async restore(): Promise<void> {
    const sessions = await listAllSessions(this.deps.db);
    for (const session of sessions) {
      if (session.status === 'logged_out') continue;
      try {
        const runtime = await this.ensureRuntime(session);
        await runtime.start();
      } catch (error) {
        this.deps.logger.error(
          { error, sessionId: session.id },
          'Failed to restore WhatsApp session'
        );
      }
    }
  }

  async create(tenantId: string, name: string): Promise<WaSession> {
    const [tenantCount, totalCount] = await Promise.all([
      countSessionsForTenant(this.deps.db, tenantId),
      countAllSessions(this.deps.db)
    ]);

    if (tenantCount >= this.deps.config.MAX_SESSIONS_PER_TENANT) {
      throw ApiError.conflict(
        'session_limit_reached',
        `This tenant already has the maximum of ${this.deps.config.MAX_SESSIONS_PER_TENANT} sessions`
      );
    }
    if (totalCount >= this.deps.config.MAX_SESSIONS_TOTAL) {
      throw ApiError.serviceUnavailable(
        'gateway_session_limit_reached',
        'The gateway has reached its maximum number of sessions'
      );
    }

    const session = await createSession(this.deps.db, randomUUID(), tenantId, name);

    try {
      const runtime = await this.ensureRuntime(session);
      await runtime.start();
    } catch (error) {
      const runtime = this.runtimes.get(session.id);
      this.runtimes.delete(session.id);
      if (runtime) {
        await runtime.destroy().catch((destroyError) => {
          this.deps.logger.warn(
            { error: destroyError, sessionId: session.id },
            'Failed to clean up runtime after session start failure'
          );
        });
      }
      await deleteSession(this.deps.db, tenantId, session.id).catch(() => undefined);
      this.deps.logger.error(
        { error, tenantId, sessionId: session.id },
        'Failed to start new session'
      );
      throw ApiError.serviceUnavailable(
        'session_start_failed',
        `Could not start the WhatsApp session: ${(error as Error).message}`
      );
    }

    const refreshed = await getSessionById(this.deps.db, session.id);
    return refreshed ?? session;
  }

  async reconnect(session: WaSession): Promise<WaSession> {
    const runtime = await this.ensureRuntime(session);
    if (session.status === 'logged_out') {
      await runtime.reconnectFresh();
    } else {
      await runtime.stopSocket();
      await updateSessionState(this.deps.db, session.id, {
        status: 'pending',
        qr: null,
        qrUpdatedAt: null,
        lastError: null
      });
      await runtime.start();
    }
    const refreshed = await getSessionById(this.deps.db, session.id);
    return refreshed ?? session;
  }

  async requestPairingCode(
    session: WaSession,
    phoneNumber: string
  ): Promise<string> {
    const runtime = await this.ensureRuntime(session);
    await runtime.start();
    return runtime.requestPairingCode(phoneNumber);
  }

  async logout(session: WaSession): Promise<void> {
    const runtime = this.runtimes.get(session.id);
    if (runtime) {
      await runtime.logout();
      return;
    }
    await this.deps.storage.removeAuthState(session.id);
    await updateSessionState(this.deps.db, session.id, {
      status: 'logged_out',
      qr: null,
      qrUpdatedAt: null
    });
  }

  async remove(session: WaSession): Promise<void> {
    const runtime = this.runtimes.get(session.id);
    this.runtimes.delete(session.id);

    if (runtime) {
      try {
        await runtime.destroy();
      } catch (error) {
        this.deps.logger.warn(
          { error, sessionId: session.id },
          'Failed to fully destroy session runtime'
        );
      }
    } else {
      await this.deps.storage.removeAuthState(session.id);
    }

    const media = await listMediaForSession(this.deps.db, session.tenantId, session.id);
    await deleteMediaForSession(this.deps.db, session.tenantId, session.id);
    const deleted = await deleteSession(this.deps.db, session.tenantId, session.id);
    if (!deleted) {
      throw ApiError.notFound('Session not found');
    }

    for (const item of media) {
      await this.deps.storage.removeFile(item.filePath);
    }
  }

  async enqueue(session: WaSession, messageId: string): Promise<void> {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) {
      throw ApiError.serviceUnavailable(
        'session_runtime_unavailable',
        'Session runtime is not running'
      );
    }
    if (!runtime.isConnected()) {
      throw ApiError.conflict(
        'session_not_connected',
        'WhatsApp session is not connected'
      );
    }
    await runtime.enqueue(messageId);
  }

  async listGroups(session: WaSession): Promise<unknown[]> {
    return this.requireRuntime(session).listGroups();
  }

  async getGroup(session: WaSession, jid: string): Promise<unknown> {
    return this.requireRuntime(session).getGroup(jid);
  }

  async shutdown(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.shutdown()));
  }

  private requireRuntime(session: WaSession): SessionRuntime {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) {
      throw ApiError.conflict(
        'session_not_connected',
        'WhatsApp session is not connected'
      );
    }
    if (!runtime.isConnected()) {
      throw ApiError.conflict(
        'session_not_connected',
        'WhatsApp session is not connected'
      );
    }
    return runtime;
  }

  private async ensureRuntime(session: WaSession): Promise<SessionRuntime> {
    const existing = this.runtimes.get(session.id);
    if (existing) return existing;

    const runtime = new SessionRuntime(session, this.deps);
    this.runtimes.set(session.id, runtime);
    return runtime;
  }
}
