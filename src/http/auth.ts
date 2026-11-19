import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { ApiError } from '../errors.js';
import { findActiveApiKeyByHash, touchApiKey } from '../repos/apiKeys.js';
import {
  findDashboardAuthByTokenHash,
  touchDashboardSession,
  type DashboardAuthRecord
} from '../repos/dashboardSessions.js';
import { getTenant } from '../repos/tenants.js';
import { extractBearerToken, hashApiKey } from '../security/apiKey.js';
import {
  DASHBOARD_COOKIE_NAME,
  DASHBOARD_CSRF_HEADER,
  hashSessionToken
} from '../security/dashboardAuth.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

/**
 * Dashboard sessions are cookie based, so state-changing requests must carry
 * a custom header. Browsers cannot set it cross-origin without a CORS
 * preflight, which the gateway does not allow by default.
 */
export function assertDashboardCsrf(request: FastifyRequest): void {
  if (!isUnsafeMethod(request.method)) return;
  if (request.headers[DASHBOARD_CSRF_HEADER] !== '1') {
    throw new ApiError(
      403,
      'csrf_check_failed',
      `Missing ${DASHBOARD_CSRF_HEADER}: 1 header for a dashboard request`
    );
  }
}

export async function readDashboardAuth(
  db: Db,
  request: FastifyRequest
): Promise<DashboardAuthRecord | null> {
  const token = request.cookies?.[DASHBOARD_COOKIE_NAME];
  if (!token) return null;

  const auth = await findDashboardAuthByTokenHash(
    db,
    hashSessionToken(token)
  );
  if (!auth) return null;

  void touchDashboardSession(db, auth.session.id).catch(() => undefined);
  return auth;
}

export function createAuthenticator(db: Db) {
  return async function authenticate(
    request: FastifyRequest,
    _reply: FastifyReply
  ): Promise<void> {
    if (request.headers.authorization !== undefined) {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) throw ApiError.unauthorized();

      const apiKey = await findActiveApiKeyByHash(db, hashApiKey(token));
      if (!apiKey) throw ApiError.unauthorized();

      const tenant = await getTenant(db, apiKey.tenantId);
      if (!tenant) throw ApiError.unauthorized();

      request.tenant = tenant;
      request.apiKeyId = apiKey.id;
      request.authMethod = 'api_key';
      void touchApiKey(db, apiKey.id).catch(() => undefined);
      return;
    }

    if (!request.cookies?.[DASHBOARD_COOKIE_NAME]) {
      throw ApiError.unauthorized(
        'Authentication required: provide a Bearer API key or dashboard login'
      );
    }

    assertDashboardCsrf(request);

    const auth = await readDashboardAuth(db, request);
    if (!auth) throw ApiError.unauthorized('Dashboard login required');

    request.tenant = auth.tenant;
    request.authMethod = 'dashboard';
    request.userId = auth.user.id;
    request.dashboardSessionId = auth.session.id;
  };
}

export function verifyAdminSecret(
  config: Config,
  provided: string | string[] | undefined
): boolean {
  if (!config.ADMIN_SECRET) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const expected = Buffer.from(config.ADMIN_SECRET, 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
