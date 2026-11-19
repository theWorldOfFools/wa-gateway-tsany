import { createWriteStream, promises as fs } from 'node:fs';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../errors.js';

export interface UrlSafetyOptions {
  allowPrivate: boolean;
  timeoutMs?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') return true;

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);

  const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if (Number.isNaN(firstHextet)) return true;
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((firstHextet & 0xff00) === 0xff00) return true; // multicast
  if ((firstHextet & 0xffff) === 0x2002) return true; // 6to4 embedding
  return false;
}

export function isPrivateIp(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export async function validateOutboundUrl(
  rawUrl: string,
  options: UrlSafetyOptions
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw ApiError.badRequest('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw ApiError.badRequest('Only http and https URLs are supported');
  }
  if (!url.hostname) throw ApiError.badRequest('URL must include a hostname');
  if (url.username || url.password) {
    throw ApiError.badRequest('URLs with embedded credentials are not supported');
  }
  if (options.allowPrivate) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isPrivateIp(hostname)) {
      throw ApiError.badRequest('URL points to a private or reserved address');
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw ApiError.badGateway('dns_lookup_failed', `Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0) {
    throw ApiError.badGateway('dns_lookup_failed', `Could not resolve host: ${hostname}`);
  }
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw ApiError.badRequest('URL resolves to a private or reserved address');
  }

  return url;
}

export interface DownloadResult {
  finalUrl: string;
  sizeBytes: number;
  contentType: string | null;
}

export async function downloadToFile(
  rawUrl: string,
  destinationPath: string,
  maxBytes: number,
  options: UrlSafetyOptions
): Promise<DownloadResult> {
  let current = await validateOutboundUrl(rawUrl, options);
  const timeoutMs = options.timeoutMs ?? 30_000;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'wa-gateway/0.1' }
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw ApiError.badGateway('media_fetch_failed', 'Redirect without a location header');
      }
      const nextUrl = new URL(location, current).toString();
      current = await validateOutboundUrl(nextUrl, options);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw ApiError.badGateway(
        'media_fetch_failed',
        `Media download failed with HTTP ${response.status}`
      );
    }

    if (!response.body) {
      throw ApiError.badGateway('media_fetch_failed', 'Media response had no body');
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > maxBytes) {
      await response.body.cancel();
      throw ApiError.tooLarge(
        `Media exceeds the maximum allowed size of ${maxBytes} bytes`
      );
    }

    let sizeBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) {
          callback(
            ApiError.tooLarge(`Media exceeds the maximum allowed size of ${maxBytes} bytes`)
          );
          return;
        }
        callback(null, chunk);
      }
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        limiter,
        createWriteStream(destinationPath, { flags: 'wx' })
      );
    } catch (error) {
      await fs.unlink(destinationPath).catch(() => undefined);
      if (error instanceof ApiError) throw error;
      throw ApiError.badGateway(
        'media_fetch_failed',
        `Failed to download media: ${(error as Error).message}`
      );
    }

    return {
      finalUrl: current.toString(),
      sizeBytes,
      contentType: response.headers.get('content-type')
    };
  }

  throw ApiError.badGateway('media_fetch_failed', 'Too many redirects');
}
