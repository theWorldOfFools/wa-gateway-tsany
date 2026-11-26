import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MessageRecord } from '../src/domain.js';
import { buildSentMessageContent } from '../src/wa/sender.js';

function record(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    direction: 'out',
    kind: 'text',
    content: null,
    payload: null,
    ...overrides
  } as MessageRecord;
}

describe('buildSentMessageContent', () => {
  it('rebuilds text content from the stored message', () => {
    const content = buildSentMessageContent(
      record({
        kind: 'text',
        content: 'Halo',
        payload: { to: '628123@s.whatsapp.net', text: 'Halo' }
      })
    );

    assert.equal(content?.conversation, 'Halo');
  });

  it('rebuilds wrapped native flow content for button messages', () => {
    const content = buildSentMessageContent(
      record({
        kind: 'interactive',
        content: 'Pilih',
        payload: {
          to: '628123@s.whatsapp.net',
          interactive: {
            type: 'buttons',
            text: 'Pilih',
            buttons: [{ id: 'ya', text: 'Ya' }]
          }
        }
      })
    );
    const wrapped = content?.viewOnceMessage?.message;

    assert.equal(wrapped?.messageContextInfo?.deviceListMetadataVersion, 2);
    assert.equal(wrapped?.interactiveMessage?.body?.text, 'Pilih');
    assert.equal(
      wrapped?.interactiveMessage?.nativeFlowMessage?.buttons?.length,
      1
    );
  });

  it('rebuilds classic list content for list messages', () => {
    const content = buildSentMessageContent(
      record({
        kind: 'interactive',
        content: 'Pilih',
        payload: {
          to: '628123@s.whatsapp.net',
          interactive: {
            type: 'list',
            text: 'Pilih',
            buttonText: 'Buka',
            sections: [
              { rows: [{ id: 'satu', title: 'Satu' }] }
            ]
          }
        }
      })
    );

    assert.equal(content?.viewOnceMessage ?? null, null);
    assert.equal(content?.listMessage?.description, 'Pilih');
    assert.equal(content?.listMessage?.sections?.[0]?.rows?.[0]?.rowId, 'satu');
  });

  it('does not rebuild media or inbound content', () => {
    assert.equal(
      buildSentMessageContent(
        record({ kind: 'image', payload: { to: '628123@s.whatsapp.net' } })
      ),
      undefined
    );
    assert.equal(
      buildSentMessageContent(
        record({ direction: 'in', kind: 'text', content: 'Halo' })
      ),
      undefined
    );
  });
});
