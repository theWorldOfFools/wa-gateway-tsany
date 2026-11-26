import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { AnalysisConfigRecord } from '../src/domain.js';
import { ApiMetrics } from '../src/analytics/metrics.js';
import { resolveTimeRange } from '../src/analytics/range.js';
import {
  analyzeTextInternal,
  INTERNAL_ANALYZER_VERSION
} from '../src/analysis/internalAnalyzer.js';
import {
  buildExternalAnalysisRequest,
  callExternalAnalyzer
} from '../src/analysis/externalAnalyzer.js';
import { analysisConfigDto } from '../src/http/dto.js';
import { defaultAnalysisConfig } from '../src/repos/analysis.js';
import { computeWebhookSignature } from '../src/security/webhook.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/wa_gateway'
});

function externalConfig(overrides = {}): AnalysisConfigRecord {
  return {
    ...defaultAnalysisConfig('tenant-1', config),
    mode: 'external',
    endpoint: 'https://analyzer.example.com/v1/analyze',
    secret: 'ansec_test_secret',
    ...overrides
  };
}

describe('internal analyzer', () => {
  it('detects a positive sentiment and a thanks intent', () => {
    const result = analyzeTextInternal('Terima kasih, layanannya bagus dan cepat!');
    assert.equal(result.label, 'positive');
    assert.equal(result.intent, 'thanks');
    assert.ok(result.score > 0);
  });

  it('detects a negative sentiment and a complaint intent', () => {
    const result = analyzeTextInternal('Saya kecewa, layanannya lambat dan rusak.');
    assert.equal(result.label, 'negative');
    assert.equal(result.intent, 'complaint');
    assert.ok(result.score < 0);
  });

  it('stays neutral when there is no clear signal', () => {
    const result = analyzeTextInternal('Cuaca cerah hari ini.');
    assert.equal(result.label, 'neutral');
    assert.equal(result.intent, 'other');
    assert.equal(result.score, 0);
  });

  it('honors the maximum text length and exposes the analyzer version', () => {
    const long = 'a'.repeat(50);
    const result = analyzeTextInternal(long, 10);
    assert.equal(result.summary, 'a'.repeat(10));
    assert.equal(INTERNAL_ANALYZER_VERSION, 'heuristic-v1');
  });
});

describe('external analyzer request', () => {
  it('signs the body with the shared secret', () => {
    const request = buildExternalAnalysisRequest({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      messageId: null,
      text: 'Halo',
      config: externalConfig(),
      globalConfig: config
    });

    assert.equal(request.url.hostname, 'analyzer.example.com');
    assert.equal(request.headers['x-wa-event'], 'analysis.request');
    assert.equal(
      request.headers['x-wa-signature'],
      computeWebhookSignature(
        'ansec_test_secret',
        request.timestamp,
        request.body
      )
    );

    const payload = JSON.parse(request.body);
    assert.equal(payload.event, 'analysis.request');
    assert.equal(payload.data.text, 'Halo');
    assert.equal(payload.data.messageId, null);
  });

  it('uses a bearer token when configured', () => {
    const request = buildExternalAnalysisRequest({
      tenantId: 'tenant-1',
      sessionId: null,
      messageId: 'message-1',
      text: 'Halo',
      config: externalConfig({ authMode: 'bearer' }),
      globalConfig: config
    });
    assert.equal(request.headers.authorization, 'Bearer ansec_test_secret');
    assert.equal(request.headers['x-wa-signature'], undefined);
  });

  it('redacts JIDs by default and includes them only when opted out', () => {
    const message = {
      direction: 'in',
      kind: 'text',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      remoteJid: '12345@s.whatsapp.net',
      senderJid: '12345@s.whatsapp.net'
    };

    const redacted = buildExternalAnalysisRequest({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      text: 'Halo',
      config: externalConfig(),
      globalConfig: config,
      message
    });
    const redactedBody = JSON.parse(redacted.body);
    assert.equal(redactedBody.data.remoteJid, undefined);
    assert.equal(redactedBody.data.senderJid, undefined);

    const exposed = buildExternalAnalysisRequest({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      text: 'Halo',
      config: externalConfig({ redact: false }),
      globalConfig: config,
      message
    });
    const exposedBody = JSON.parse(exposed.body);
    assert.equal(exposedBody.data.remoteJid, message.remoteJid);
    assert.equal(exposedBody.data.senderJid, message.senderJid);
  });
});

describe('external analyzer call', () => {
  it('posts a signed request and validates the JSON response', async () => {
    const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          headers: request.headers as Record<string, unknown>,
          body: Buffer.concat(chunks).toString('utf8')
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            label: 'positive',
            intent: 'thanks',
            score: 0.8,
            keywords: ['terima kasih'],
            summary: 'Pelanggan berterima kasih',
            analyzerVersion: 'mock-v1'
          })
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    try {
      const result = await callExternalAnalyzer({
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        text: 'Terima kasih',
        config: externalConfig({
          endpoint: `http://127.0.0.1:${address.port}/analyze`,
          secret: 'ansec_test_secret'
        }),
        globalConfig: loadConfig({
          DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/wa_gateway',
          ALLOW_PRIVATE_ANALYSIS_ENDPOINTS: 'true'
        })
      });

      assert.equal(result.result.label, 'positive');
      assert.equal(result.version, 'mock-v1');
      assert.equal(received.length, 1);
      const request = received[0]!;
      assert.equal(request.headers['x-wa-event'], 'analysis.request');
      assert.equal(
        request.headers['x-wa-signature'],
        computeWebhookSignature(
          'ansec_test_secret',
          String(request.headers['x-wa-timestamp']),
          request.body
        )
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

describe('analysis time range', () => {
  it('defaults to the last seven days', () => {
    const range = resolveTimeRange(undefined, '2026-01-08T00:00:00.000Z');
    assert.equal(range.to.toISOString(), '2026-01-08T00:00:00.000Z');
    assert.equal(
      range.from.toISOString(),
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('rejects invalid and reversed ranges', () => {
    assert.throws(() => resolveTimeRange('invalid', undefined));
    assert.throws(() =>
      resolveTimeRange('2026-01-08T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    );
  });

  it('rejects ranges longer than 90 days', () => {
    assert.throws(() =>
      resolveTimeRange('2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    );
  });
});

describe('analysis configuration DTO', () => {
  it('does not expose the analyzer secret', () => {
    const record = externalConfig();
    const dto = analysisConfigDto(record);
    assert.equal(dto.secret, undefined);
    assert.equal(dto.hasSecret, true);
    assert.equal(dto.secretHint, `••••${record.secret?.slice(-4)}`);
  });
});

describe('API metrics aggregation', () => {
  it('accumulates requests into the current minute bucket', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      query: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      }
    };

    const metrics = new ApiMetrics();
    metrics.record('tenant-1', '/v1/messages', 'POST', 200, 12);
    metrics.record('tenant-1', '/v1/messages', 'POST', 404, 8);

    const flushed = await metrics.flush(db as never);
    assert.equal(flushed, 2);
    assert.equal(queries.length, 2);
    assert.deepEqual(
      queries.map((entry) => entry.values[5]).sort(),
      [1, 1]
    );
    assert.equal(await metrics.flush(db as never), 0);
  });
});
