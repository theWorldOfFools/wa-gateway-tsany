export type SessionStatus =
  | 'pending'
  | 'qr'
  | 'connected'
  | 'disconnected'
  | 'logged_out'
  | 'error';

export type MessageDirection = 'in' | 'out';

export type MessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'received';

export type MessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'interactive'
  | 'interactive_reply'
  | 'other';

export type AnalysisSource = 'internal' | 'external';
export type AnalysisMode = 'internal' | 'external' | 'both';
export type AnalysisAuthMode = 'signature' | 'bearer' | 'none';
export type AnalysisStatus = 'pending' | 'completed' | 'failed';

export interface Tenant {
  id: string;
  name: string;
  createdAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface WaSession {
  id: string;
  tenantId: string;
  name: string;
  status: SessionStatus;
  phoneNumber: string | null;
  jid: string | null;
  qr: string | null;
  qrUpdatedAt: Date | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  webhookEvents: string[];
  interactiveFallback: boolean;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaRecord {
  id: string;
  tenantId: string;
  sessionId: string | null;
  direction: MessageDirection;
  mimeType: string;
  fileName: string | null;
  filePath: string;
  sizeBytes: number;
  createdAt: Date;
}

export type AuthMethod = 'api_key' | 'dashboard';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface DashboardSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export interface MessageRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  direction: MessageDirection;
  kind: MessageKind;
  status: MessageStatus;
  remoteJid: string;
  senderJid: string | null;
  isGroup: boolean;
  content: string | null;
  payload: unknown;
  mediaId: string | null;
  waMessageId: string | null;
  error: string | null;
  idempotencyKey: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnalysisConfigRecord {
  tenantId: string;
  enabled: boolean;
  mode: AnalysisMode;
  endpoint: string | null;
  authMode: AnalysisAuthMode;
  secret: string | null;
  redact: boolean;
  maxChars: number;
  timeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnalysisResultData {
  label: 'positive' | 'negative' | 'neutral';
  intent: string;
  score: number;
  keywords: string[];
  summary: string;
}

export interface MessageAnalysisRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  messageId: string;
  source: AnalysisSource;
  status: AnalysisStatus;
  result: AnalysisResultData | null;
  raw: unknown;
  error: string | null;
  durationMs: number | null;
  analyzerVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
}
