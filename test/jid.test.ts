import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors.js';
import {
  isGroupJid,
  jidToPhone,
  normalizeRecipient
} from '../src/wa/jid.js';

describe('normalizeRecipient', () => {
  it('converts a plain phone number to a user JID', () => {
    assert.equal(
      normalizeRecipient('6281234567890'),
      '6281234567890@s.whatsapp.net'
    );
  });

  it('strips formatting characters from phone numbers', () => {
    assert.equal(
      normalizeRecipient('+62 (812) 3456-7890'),
      '6281234567890@s.whatsapp.net'
    );
  });

  it('accepts and normalizes user JIDs with a device suffix', () => {
    assert.equal(
      normalizeRecipient('6281234567890:12@s.whatsapp.net'),
      '6281234567890@s.whatsapp.net'
    );
  });

  it('accepts group JIDs unchanged', () => {
    assert.equal(
      normalizeRecipient('120363012345678901@g.us'),
      '120363012345678901@g.us'
    );
    assert.equal(isGroupJid('120363012345678901@g.us'), true);
  });

  it('accepts LID JIDs', () => {
    assert.equal(
      normalizeRecipient('123456789012345@lid'),
      '123456789012345@lid'
    );
  });

  it('rejects unsupported JID servers', () => {
    assert.throws(
      () => normalizeRecipient('foo@example.com'),
      (error: unknown) =>
        error instanceof ApiError && error.statusCode === 400
    );
  });

  it('rejects malformed phone numbers', () => {
    assert.throws(() => normalizeRecipient('123'), /Recipient must be/);
    assert.throws(() => normalizeRecipient('not-a-number'));
  });
});

describe('jidToPhone', () => {
  it('extracts the phone number from a JID', () => {
    assert.equal(jidToPhone('6281234567890:5@s.whatsapp.net'), '6281234567890');
  });
});
