import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DUMMY_PASSWORD_HASH,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword
} from '../src/security/dashboardAuth.js';

describe('dashboard password hashing', () => {
  it('creates scrypt hashes with a random salt', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    assert.match(first, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
    assert.notEqual(first, second);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('rahasia-dashboard-123');

    assert.equal(await verifyPassword('rahasia-dashboard-123', hash), true);
    assert.equal(await verifyPassword('salah', hash), false);
  });

  it('rejects malformed stored hashes', async () => {
    assert.equal(await verifyPassword('anything', ''), false);
    assert.equal(await verifyPassword('anything', 'plain-text'), false);
    assert.equal(
      await verifyPassword('anything', 'scrypt$999$8$1$c2FsdA$aGFzaA'),
      false
    );
  });

  it('keeps the dummy hash valid for timing equalization', async () => {
    assert.equal(
      await verifyPassword(
        'dummy-password-for-timing-equalization',
        DUMMY_PASSWORD_HASH
      ),
      true
    );
  });
});

describe('dashboard session tokens', () => {
  it('generates opaque tokens and stores only a deterministic hash', () => {
    const generated = generateSessionToken();

    assert.ok(generated.token.length >= 40);
    assert.match(generated.tokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(generated.token, generated.tokenHash);
    assert.equal(hashSessionToken(generated.token), generated.tokenHash);
  });

  it('generates a different token for every login', () => {
    const first = generateSessionToken();
    const second = generateSessionToken();

    assert.notEqual(first.token, second.token);
    assert.notEqual(first.tokenHash, second.tokenHash);
  });
});
