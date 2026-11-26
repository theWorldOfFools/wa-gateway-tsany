import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type {
  AnalysisResultData,
  AnalysisSource,
  MessageAnalysisRecord,
  MessageRecord
} from '../domain.js';
import { getMessageInternal } from '../repos/messages.js';
import {
  getAnalysisConfig,
  saveAnalysis,
  type SaveAnalysisInput
} from '../repos/analysis.js';
import { WebhookDispatcher } from '../webhooks/dispatcher.js';
import {
  analyzeTextInternal,
  INTERNAL_ANALYZER_VERSION
} from './internalAnalyzer.js';
import { callExternalAnalyzer } from './externalAnalyzer.js';

const EXTERNAL_ATTEMPTS = 3;
const EXTERNAL_RETRY_DELAYS_MS = [500, 1_500];

export interface TextAnalysis {
  source: AnalysisSource;
  result: AnalysisResultData;
  version: string;
}

export class AnalysisService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly webhooks: WebhookDispatcher
  ) {}

  /** Analyze a stored message and emit the result through the webhook dispatcher. */
  async analyzeMessage(
    messageId: string,
    sources?: AnalysisSource[]
  ): Promise<MessageAnalysisRecord[]> {
    const message = await getMessageInternal(this.db, messageId);
    if (!message) return [];

    const analysisConfig = await getAnalysisConfig(
      this.db,
      message.tenantId,
      this.config
    );
    if (!analysisConfig.enabled) return [];

    const text = (message.content ?? '').trim().slice(0, analysisConfig.maxChars);
    if (!text) return [];

    const selected = sources ?? this.sourcesFor(analysisConfig.mode);
    const records: MessageAnalysisRecord[] = [];

    for (const source of selected) {
      if (
        source === 'external' &&
        (!analysisConfig.mode.includes('external') || !analysisConfig.endpoint)
      ) {
        continue;
      }

      const started = Date.now();
      try {
        const analysis =
          source === 'internal'
            ? {
                result: analyzeTextInternal(text, analysisConfig.maxChars),
                version: INTERNAL_ANALYZER_VERSION,
                raw: null
              }
            : await this.callExternal(
                {
                  tenantId: message.tenantId,
                  sessionId: message.sessionId,
                  messageId: message.id,
                  text,
                  config: analysisConfig,
                  globalConfig: this.config,
                  message: {
                    direction: message.direction,
                    kind: message.kind,
                    createdAt: message.createdAt,
                    remoteJid: message.remoteJid,
                    senderJid: message.senderJid
                  }
                },
                this.logger
              );

        const record = await this.persist(message, source, 'completed', {
          result: analysis.result,
          raw: analysis.raw,
          durationMs: Date.now() - started,
          analyzerVersion: analysis.version
        });
        records.push(record);

        this.emit(message, record, 'analysis.completed', text);
      } catch (error) {
        const messageError = (error as Error).message;
        const record = await this.persist(message, source, 'failed', {
          error: messageError,
          durationMs: Date.now() - started
        });
        records.push(record);
        this.logger.warn(
          { messageId, source, error: messageError },
          'Message analysis failed'
        );
        this.emit(message, record, 'analysis.failed', text);
      }
    }

    return records;
  }

  /** Analyze ad-hoc text without storing a message. */
  async analyzeText(
    tenantId: string,
    text: string,
    options: {
      source?: AnalysisSource;
      sessionId?: string | null;
    } = {}
  ): Promise<TextAnalysis> {
    const analysisConfig = await getAnalysisConfig(this.db, tenantId, this.config);
    if (!analysisConfig.enabled) {
      throw new Error('Analysis is disabled for this tenant');
    }

    const clean = text.trim().slice(0, analysisConfig.maxChars);
    const source = options.source ?? 'internal';

    if (source === 'internal') {
      return {
        source,
        result: analyzeTextInternal(clean, analysisConfig.maxChars),
        version: INTERNAL_ANALYZER_VERSION
      };
    }

    if (!analysisConfig.endpoint) {
      throw new Error('External analyzer endpoint is not configured');
    }

    const analysis = await this.callExternal(
      {
        tenantId,
        sessionId: options.sessionId ?? null,
        messageId: null,
        text: clean,
        config: analysisConfig,
        globalConfig: this.config
      },
      this.logger
    );
    return { source, result: analysis.result, version: analysis.version };
  }

  private sourcesFor(mode: string): AnalysisSource[] {
    if (mode === 'external') return ['external'];
    if (mode === 'both') return ['internal', 'external'];
    return ['internal'];
  }

  private async callExternal(
    input: Parameters<typeof callExternalAnalyzer>[0],
    logger: Logger
  ): Promise<Awaited<ReturnType<typeof callExternalAnalyzer>>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < EXTERNAL_ATTEMPTS; attempt += 1) {
      try {
        return await callExternalAnalyzer(input, logger);
      } catch (error) {
        lastError = error;
        const delay = EXTERNAL_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('External analysis failed');
  }

  private async persist(
    message: MessageRecord,
    source: AnalysisSource,
    status: 'completed' | 'failed',
    extra: Omit<SaveAnalysisInput, 'tenantId' | 'sessionId' | 'messageId' | 'source' | 'status'>
  ): Promise<MessageAnalysisRecord> {
    return saveAnalysis(this.db, {
      tenantId: message.tenantId,
      sessionId: message.sessionId,
      messageId: message.id,
      source,
      status,
      ...extra
    });
  }

  private emit(
    message: MessageRecord,
    record: MessageAnalysisRecord,
    event: 'analysis.completed' | 'analysis.failed',
    text: string
  ): void {
    this.webhooks.emit(message.sessionId, event, {
      id: record.id,
      messageId: message.id,
      sessionId: message.sessionId,
      source: record.source,
      status: record.status,
      label: record.result?.label ?? null,
      intent: record.result?.intent ?? null,
      score: record.result?.score ?? null,
      keywords: record.result?.keywords ?? [],
      summary: record.result?.summary ?? null,
      error: record.error,
      text,
      createdAt: record.createdAt.toISOString()
    });
  }
}
