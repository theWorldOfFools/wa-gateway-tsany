import { ApiError } from '../errors.js';

const USER_SERVER = 's.whatsapp.net';
const GROUP_SERVER = 'g.us';
const LID_SERVERS = new Set(['lid', 'hosted.lid', 'hosted']);

export function isGroupJid(jid: string): boolean {
  return jid.endsWith(`@${GROUP_SERVER}`);
}

export function isUserJid(jid: string): boolean {
  return jid.endsWith(`@${USER_SERVER}`);
}

export function jidToPhone(jid: string): string {
  const local = jid.split('@')[0] ?? '';
  return local.split(':')[0] ?? '';
}

export function normalizeRecipient(input: string): string {
  const value = input.trim();
  if (!value) throw ApiError.badRequest('Recipient is required');

  if (value.includes('@')) {
    const [local, server] = value.split('@');
    if (!local || !server) throw ApiError.badRequest('Invalid recipient JID');

    if (server === GROUP_SERVER) {
      if (!/^[\d-]+$/.test(local)) {
        throw ApiError.badRequest('Invalid group JID');
      }
      return value;
    }

    if (server === USER_SERVER) {
      const phone = local.split(':')[0] ?? '';
      if (!/^\d{7,15}$/.test(phone)) {
        throw ApiError.badRequest('Invalid phone number in recipient JID');
      }
      return `${phone}@${USER_SERVER}`;
    }

    if (LID_SERVERS.has(server)) {
      const lid = local.split(':')[0] ?? '';
      if (!/^\d{6,20}$/.test(lid)) {
        throw ApiError.badRequest('Invalid LID recipient JID');
      }
      return `${lid}@${server}`;
    }

    throw ApiError.badRequest(
      'Recipient JID must use @s.whatsapp.net, @lid or @g.us'
    );
  }

  const digits = value.replace(/[\s()+\-.]/g, '');
  if (!/^\d{7,15}$/.test(digits)) {
    throw ApiError.badRequest(
      'Recipient must be a phone number or a WhatsApp JID'
    );
  }
  return `${digits}@${USER_SERVER}`;
}
