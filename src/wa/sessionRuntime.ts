import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  type WAVersion,
  type WASocket,
  type WAMessage
} from '@whiskeysockets/baileys';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { MessageStatus, WaSession } from '../domain.js';
import { ApiError } from '../errors.js';
import type { MediaStorage } from '../media/storage.js';
import { SessionQueue } from '../queue/sessionQueue.js';
import {
  findByWaMessageId,
  getMessageInternal,
  updateMessageStatus,
  updateStatusByWaMessageId
} from '../repos/messages.js';
import { getSessionById, updateSessionState } from '../repos/sessions.js';
import type { WebhookDispatcher } from '../webhooks/dispatcher.js';
import { InboundHandler, toMessageDto } from './inbound.js';
import { jidToPhone } from './jid.js';
import { buildSentMessageContent, MessageSender } from './sender.js';

let cachedVersion: Promise<WAVersion | undefined> | null = null;

function resolveBaileysVersion(logger: Logger): Promise<WAVersion | undefined> {
  if (!cachedVersion) {
    cachedVersion = fetchLatestBaileysVersion()
      .then(({ version }) => version)
      .catch((error) => {
        logger.warn({ error }, 'Could not fetch the latest Baileys version; using default');
        return undefined;
      });
  }
  return cachedVersion;
}

export interface SessionRuntimeDeps {
  config: Config;
  db: Db;
  logger: Logger;
  storage: MediaStorage;
  webhooks: WebhookDispatcher;
  sender: MessageSender;
  inbound: InboundHandler;
}

export class SessionRuntime {
  private sock: WASocket | null = null;
  private stopped = false;
  private connecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly queue: SessionQueue;
  readonly sessionId: string;
  private readonly tenantId: string;

  constructor(
    session: WaSession,
    private readonly deps: SessionRuntimeDeps
  ) {
    this.sessionId = session.id;
    this.tenantId = session.tenantId;
    this.queue = new SessionQueue(
      session.id,
      deps.config.REDIS_URL,
      (messageId) => this.processOutbound(messageId),
      deps.config.WA_SEND_INTERVAL_MS,
      deps.logger.child({ module: 'queue', sessionId: session.id }),
      (messageId, error) => this.onOutboundFailed(messageId, error)
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connecting || this.sock) return;
    await this.connect();
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) {
      throw ApiError.conflict('session_not_ready', 'Session socket is not ready yet');
    }
    if (this.sock.authState.creds.registered) {
      throw ApiError.conflict(
        'session_already_registered',
        'This session already has WhatsApp credentials'
      );
    }
    return this.sock.requestPairingCode(phoneNumber);
  }

  async enqueue(messageId: string): Promise<void> {
    await this.queue.enqueue(messageId);
  }

  async logout(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();

    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        await sock.logout();
      } catch (error) {
        this.deps.logger.warn(
          { error, sessionId: this.sessionId },
          'WhatsApp logout call failed; continuing with local cleanup'
        );
      }
      try {
        sock.end(undefined);
      } catch {
        // socket may already be closed
      }
    }

    await this.deps.storage.removeAuthState(this.sessionId);
    await updateSessionState(this.deps.db, this.sessionId, {
      status: 'logged_out',
      qr: null,
      qrUpdatedAt: null,
      lastError: null
    });
    this.deps.webhooks.emit(this.sessionId, 'session.logged_out', {});
  }

  async reconnectFresh(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.connecting = false;
    await this.deps.storage.removeAuthState(this.sessionId);
    this.sock = null;
    await updateSessionState(this.deps.db, this.sessionId, {
      status: 'pending',
      qr: null,
      qrUpdatedAt: null,
      lastError: null
    });
    await this.start();
  }

  async stopSocket(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // ignore
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.stopSocket();
    await this.queue.close(false);
  }

  async destroy(): Promise<void> {
    await this.stopSocket();
    await this.queue.close(true);
    await this.deps.storage.removeAuthState(this.sessionId);
  }

  isConnected(): boolean {
    return this.sock?.user != null;
  }

  async listGroups(): Promise<unknown[]> {
    const sock = this.requireConnectedSocket();
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups).map(serializeGroup);
  }

  async getGroup(jid: string): Promise<unknown> {
    const sock = this.requireConnectedSocket();
    const groups = await sock.groupFetchAllParticipating();
    const group = groups[jid];
    if (group) return serializeGroup(group);
    return serializeGroup(await sock.groupMetadata(jid));
  }

  private requireConnectedSocket(): WASocket {
    if (!this.sock?.user) {
      throw ApiError.conflict('session_not_connected', 'WhatsApp session is not connected');
    }
    return this.sock;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;

    try {
      const authDir = path.join(this.deps.config.authDir, this.sessionId);
      await fs.mkdir(authDir, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const version = await resolveBaileysVersion(this.deps.logger);
      const sessionLogger = this.deps.logger.child(
        { module: 'baileys', sessionId: this.sessionId },
        { level: this.deps.config.NODE_ENV === 'development' ? 'debug' : 'warn' }
      );

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, sessionLogger)
        },
        logger: sessionLogger,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        getMessage: async (key) => {
          if (!key.id) return undefined;
          const record = await findByWaMessageId(
            this.deps.db,
            this.sessionId,
            key.id
          );
          const content = record
            ? buildSentMessageContent(record)
            : undefined;
          if (!content) {
            sessionLogger.debug(
              { msgId: key.id },
              'No stored content available for retry request'
            );
          }
          return content;
        }
      });

      this.sock = sock;

      sock.ev.process(async (events) => {
        try {
          if (events['creds.update']) {
            await saveCreds();
          }

          if (events['connection.update']) {
            await this.handleConnectionUpdate(events['connection.update'], sock);
          }

          const upsert = events['messages.upsert'];
          if (upsert?.type === 'notify') {
            await this.deps.inbound.handle(
              { id: this.sessionId, tenantId: this.tenantId },
              upsert.messages as WAMessage[],
              sock
            );
          }

          const updates = events['messages.update'];
          if (updates) {
            await this.handleMessageUpdates(updates);
          }
        } catch (error) {
          this.deps.logger.error(
            { error, sessionId: this.sessionId },
            'Error while processing Baileys events'
          );
        }
      });
    } catch (error) {
      this.connecting = false;
      this.deps.logger.error(
        { error, sessionId: this.sessionId },
        'Failed to create WhatsApp socket'
      );
      await updateSessionState(this.deps.db, this.sessionId, {
        status: 'error',
        lastError: (error as Error).message
      }).catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private async handleConnectionUpdate(
    update: Partial<{
      connection: string;
      qr: string;
      lastDisconnect: unknown;
    }>,
    sock: WASocket
  ): Promise<void> {
    if (update.qr) {
      await updateSessionState(this.deps.db, this.sessionId, {
        status: 'qr',
        qr: update.qr,
        qrUpdatedAt: new Date(),
        lastError: null
      });
      this.deps.webhooks.emit(this.sessionId, 'session.qr', {
        qr: update.qr,
        expiresInSeconds: 60
      });
    }

    if (update.connection === 'open') {
      this.connecting = false;
      this.reconnectAttempts = 0;
      const me = sock.user;
      const jid = me?.id ?? null;
      const phoneNumber = jid ? jidToPhone(jid) : null;
      await updateSessionState(this.deps.db, this.sessionId, {
        status: 'connected',
        phoneNumber,
        jid,
        qr: null,
        qrUpdatedAt: null,
        lastError: null
      });
      this.deps.logger.info(
        { sessionId: this.sessionId, phoneNumber },
        'WhatsApp session connected'
      );
      this.deps.webhooks.emit(this.sessionId, 'session.connected', {
        phoneNumber,
        jid
      });
    }

    if (update.connection === 'close') {
      this.connecting = false;
      this.sock = null;
      if (this.stopped) return;

      const statusCode = (
        update.lastDisconnect as
          | { error?: { output?: { statusCode?: number } } }
          | undefined
      )?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const message = loggedOut
        ? 'WhatsApp session was logged out'
        : `Connection closed${statusCode ? ` (status ${statusCode})` : ''}`;

      if (loggedOut) {
        this.stopped = true;
        await updateSessionState(this.deps.db, this.sessionId, {
          status: 'logged_out',
          qr: null,
          qrUpdatedAt: null,
          lastError: message
        });
        this.deps.webhooks.emit(this.sessionId, 'session.logged_out', {
          reason: message
        });
        return;
      }

      await updateSessionState(this.deps.db, this.sessionId, {
        status: 'disconnected',
        qr: null,
        qrUpdatedAt: null,
        lastError: message
      });
      this.deps.webhooks.emit(this.sessionId, 'session.disconnected', {
        reason: message,
        statusCode: statusCode ?? null
      });
      this.scheduleReconnect();
    }
  }

  private async handleMessageUpdates(
    updates: Array<{
      key: { id?: string | null };
      update: { status?: number | null };
    }>
  ): Promise<void> {
    for (const update of updates) {
      if (!update.key?.id) continue;
      const status = mapAckStatus(update.update?.status);
      if (!status) continue;

      const changed = await updateStatusByWaMessageId(
        this.deps.db,
        this.sessionId,
        update.key.id,
        status
      );
      if (changed) {
        this.deps.webhooks.emit(
          this.sessionId,
          'message.status',
          toMessageDto(changed, this.deps.config.publicUrl)
        );
      }
    }
  }

  private async processOutbound(messageId: string): Promise<void> {
    const message = await getMessageInternal(this.deps.db, messageId);
    if (!message || message.direction !== 'out') return;
    if (!['queued', 'sending'].includes(message.status)) return;

    const session = await getSessionById(this.deps.db, this.sessionId);
    if (!session) return;

    const sock = this.sock;
    if (!sock?.user) {
      throw new Error('WhatsApp session is not connected');
    }

    await updateMessageStatus(this.deps.db, messageId, { status: 'sending' });

    const result = await this.deps.sender.send(session, message, sock);
    const updated = await updateMessageStatus(this.deps.db, messageId, {
      status: 'sent',
      waMessageId: result.waMessageId,
      error: null,
      meta: { ...result.meta, sentAt: new Date().toISOString() }
    });

    if (updated) {
      this.deps.webhooks.emit(
        this.sessionId,
        'message.status',
        toMessageDto(updated, this.deps.config.publicUrl)
      );
    }
  }

  private async onOutboundFailed(messageId: string, error: Error): Promise<void> {
    const updated = await updateMessageStatus(this.deps.db, messageId, {
      status: 'failed',
      error: error.message
    });
    if (updated) {
      this.deps.webhooks.emit(
        this.sessionId,
        'message.status',
        toMessageDto(updated, this.deps.config.publicUrl)
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(
      1_000 * 2 ** this.reconnectAttempts,
      this.deps.config.SESSION_MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function mapAckStatus(status: number | null | undefined): MessageStatus | null {
  switch (status) {
    case proto.WebMessageInfo.Status.SERVER_ACK:
      return 'sent';
    case proto.WebMessageInfo.Status.DELIVERY_ACK:
      return 'delivered';
    case proto.WebMessageInfo.Status.READ:
    case proto.WebMessageInfo.Status.PLAYED:
      return 'read';
    default:
      return null;
  }
}

function serializeGroup(group: {
  id: string;
  subject?: string | null;
  desc?: string | null;
  owner?: string | null;
  creation?: number | null;
  announce?: boolean | null;
  restrict?: boolean | null;
  participants?: unknown[];
}): Record<string, unknown> {
  return {
    id: group.id,
    subject: group.subject ?? null,
    description: group.desc ?? null,
    owner: group.owner ?? null,
    creation: group.creation ?? null,
    announce: group.announce ?? false,
    restrict: group.restrict ?? false,
    participantCount: group.participants?.length ?? 0,
    participants: group.participants ?? []
  };
}
