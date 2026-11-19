import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors.js';
import { generateApiKey, hashApiKey } from '../src/security/apiKey.js';
import { isPrivateIp, validateOutboundUrl } from '../src/security/url.js';
import { computeWebhookSignature } from '../src/security/webhook.js';

describe('API keys', () => {
  it('generates prefixed keys and stores only their hash', () => {
    const generated = generateApiKey();
    assert.match(generated.key, /^wag_[A-Za-z0-9_-]{40,}$/);
    assert.equal(generated.prefix, generated.key.slice(0, 12));
    assert.equal(generated.hash, hashApiKey(generated.key));
    assert.notEqual(generated.key, generated.hash);
  });

  it('generates unique keys', () => {
    assert.notEqual(generateApiKey().key, generateApiKey().key);
  });
});

describe('webhook signatures', () => {
  it('signs the timestamp and raw body', () => {
    const secret = 'whsec_test';
    const timestamp = '1700000000';
    const body = JSON.stringify({ hello: 'world' });
    const expected = `sha256=${createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')}`;

    assert.equal(computeWebhookSignature(secret, timestamp, body), expected);
  });

  it('changes when the body changes', () => {
    const a = computeWebhookSignature('secret', '1', '{"a":1}');
    const b = computeWebhookSignature('secret', '1', '{"a":2}');
    assert.notEqual(a, b);
  });
});

describe('private IP detection', () => {
  const privateAddresses = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1'
  ];

  for (const address of privateAddresses) {
    it(`treats ${address} as private`, () => {
      assert.equal(isPrivateIp(address), true);
    });
  }

  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
    it(`treats ${address} as public`, () => {
      assert.equal(isPrivateIp(address), false);
    });
  }
});

describe('outbound URL validation', () => {
  it('rejects non-HTTP protocols', async () => {
    await assert.rejects(
      validateOutboundUrl('file:///etc/passwd', { allowPrivate: false }),
      (error: unknown) =>
        error instanceof ApiError && error.statusCode === 400
    );
  });

  it('rejects private literal addresses by default', async () => {
    await assert.rejects(
      validateOutboundUrl('http://192.168.0.10/media.png', {
        allowPrivate: false
      }),
      /private or reserved/
    );
  });

  it('allows private literals when explicitly enabled', async () => {
    const url = await validateOutboundUrl('http://192.168.0.10/media.png', {
      allowPrivate: true
    });
    assert.equal(url.hostname, '192.168.0.10');
  });

  it('rejects embedded credentials', async () => {
    await assert.rejects(
      validateOutboundUrl('https://user:pass@example.com/x', {
        allowPrivate: true
      }),
      /credentials/
    );
  });
});
