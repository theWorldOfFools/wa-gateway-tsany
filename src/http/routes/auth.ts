import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/index.js';
import type { Tenant, User } from '../../domain.js';
import { ApiError } from '../../errors.js';
import {
  createDashboardSession,
  deleteDashboardSessionByTokenHash,
  deleteExpiredDashboardSessions,
  deleteOtherDashboardSessions
} from '../../repos/dashboardSessions.js';
import { createApiKey, findActiveApiKeyByHash } from '../../repos/apiKeys.js';
import { createTenant, getTenant } from '../../repos/tenants.js';
import {
  createUser,
  getUserByEmail,
  markUserLogin,
  updateUserPassword
} from '../../repos/users.js';
import {
  extractBearerToken,
  generateApiKey,
  hashApiKey
} from '../../security/apiKey.js';
import {
  DASHBOARD_COOKIE_NAME,
  DUMMY_PASSWORD_HASH,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword
} from '../../security/dashboardAuth.js';
import {
  assertDashboardCsrf,
  readDashboardAuth,
  verifyAdminSecret
} from '../auth.js';
import type { HttpDeps } from '../deps.js';
import { parseInput } from '../validation.js';

const EmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email()
  .transform((value) => value.toLowerCase());

const PasswordSchema = z.string().min(8).max(128);
const NameSchema = z.string().trim().min(1).max(80);

const RegisterSchema = z.object({
  tenantName: z.string().trim().min(2).max(80),
  name: NameSchema.optional(),
  email: EmailSchema,
  password: PasswordSchema
});

const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128)
});

const SetupSchema = z.object({
  name: NameSchema.optional(),
  email: EmailSchema,
  password: PasswordSchema
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: PasswordSchema
});

function userDto(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null
  };
}

function tenantDto(tenant: Tenant): Record<string, unknown> {
  return {
    id: tenant.id,
    name: tenant.name,
    createdAt: tenant.createdAt.toISOString()
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function setSessionCookie(
  deps: HttpDeps,
  reply: FastifyReply,
  token: string,
  expiresAt: Date
): void {
  reply.setCookie(DASHBOARD_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: deps.config.COOKIE_SECURE,
    expires: expiresAt
  });
}

async function issueDashboardSession(
  deps: HttpDeps,
  db: Db,
  request: FastifyRequest,
  userId: string
): Promise<{ token: string; expiresAt: Date }> {
  const ttlMs = deps.config.DASHBOARD_SESSION_TTL_DAYS * 24 * 60 * 60 * 1_000;
  const expiresAt = new Date(Date.now() + ttlMs);
  const generated = generateSessionToken();

  await createDashboardSession(db, {
    id: randomUUID(),
    userId,
    tokenHash: generated.tokenHash,
    expiresAt,
    userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
    ip: request.ip
  });

  return { token: generated.token, expiresAt };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: HttpDeps
): void {
  app.post(
    '/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseInput(RegisterSchema, request.body);

      const allowed =
        deps.config.PUBLIC_SIGNUP ||
        verifyAdminSecret(deps.config, request.headers['x-admin-secret']);
      if (!allowed) {
        throw ApiError.forbidden(
          'Tenant signup is disabled. Provide a valid x-admin-secret header or activate a dashboard login with an existing API key at /v1/auth/setup.'
        );
      }

      const tenantId = randomUUID();
      const apiKeyId = randomUUID();
      const userId = randomUUID();
      const generatedKey = generateApiKey();
      const passwordHash = await hashPassword(body.password);

      const client = await deps.db.connect();
      try {
        await client.query('BEGIN');
        const tx = client as unknown as Db;

        const tenant = await createTenant(tx, tenantId, body.tenantName);
        await createApiKey(tx, {
          id: apiKeyId,
          tenantId,
          name: 'default',
          keyPrefix: generatedKey.prefix,
          keyHash: generatedKey.hash,
          scopes: ['*']
        });
        const user = await createUser(tx, {
          id: userId,
          tenantId,
          email: body.email,
          name: body.name ?? null,
          passwordHash
        });
        const issued = await issueDashboardSession(deps, tx, request, user.id);

        await client.query('COMMIT');

        setSessionCookie(deps, reply, issued.token, issued.expiresAt);

        return reply.code(201).send({
          tenant: tenantDto(tenant),
          user: userDto(user),
          session: { expiresAt: issued.expiresAt.toISOString() },
          apiKey: {
            id: apiKeyId,
            name: 'default',
            key: generatedKey.key,
            prefix: generatedKey.prefix
          },
          warning:
            'Store the API key securely. It is only shown once and cannot be recovered.'
        });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (isUniqueViolation(error)) {
          throw ApiError.conflict(
            'email_taken',
            'An account with this email already exists'
          );
        }
        throw error;
      } finally {
        client.release();
      }
    }
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseInput(LoginSchema, request.body);
      const user = await getUserByEmail(deps.db, body.email);

      const passwordMatches = user
        ? await verifyPassword(body.password, user.passwordHash)
        : await verifyPassword(body.password, DUMMY_PASSWORD_HASH);

      if (!user || !passwordMatches) {
        throw new ApiError(
          401,
          'invalid_credentials',
          'Email or password is incorrect'
        );
      }

      const tenant = await getTenant(deps.db, user.tenantId);
      if (!tenant) throw ApiError.unauthorized();

      const issued = await issueDashboardSession(
        deps,
        deps.db,
        request,
        user.id
      );
      await markUserLogin(deps.db, user.id);
      void deleteExpiredDashboardSessions(deps.db).catch(() => undefined);

      setSessionCookie(deps, reply, issued.token, issued.expiresAt);

      return {
        tenant: tenantDto(tenant),
        user: userDto({ ...user, lastLoginAt: new Date() }),
        session: { expiresAt: issued.expiresAt.toISOString() }
      };
    }
  );

  app.post('/auth/logout', async (request, reply) => {
    if (request.cookies?.[DASHBOARD_COOKIE_NAME]) {
      assertDashboardCsrf(request);
    }

    const token = request.cookies?.[DASHBOARD_COOKIE_NAME];
    if (token) {
      await deleteDashboardSessionByTokenHash(
        deps.db,
        hashSessionToken(token)
      );
    }

    reply.clearCookie(DASHBOARD_COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request) => {
    const auth = await readDashboardAuth(deps.db, request);
    if (!auth) throw ApiError.unauthorized('Dashboard login required');

    return {
      tenant: tenantDto(auth.tenant),
      user: userDto(auth.user),
      session: { expiresAt: auth.session.expiresAt.toISOString() },
      authMethod: 'dashboard'
    };
  });

  app.post(
    '/auth/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) {
        throw ApiError.unauthorized(
          'A tenant API key is required to activate a dashboard login'
        );
      }

      const apiKey = await findActiveApiKeyByHash(
        deps.db,
        hashApiKey(token)
      );
      if (!apiKey) throw ApiError.unauthorized();

      const tenant = await getTenant(deps.db, apiKey.tenantId);
      if (!tenant) throw ApiError.unauthorized();

      const body = parseInput(SetupSchema, request.body);
      const passwordHash = await hashPassword(body.password);

      try {
        const user = await createUser(deps.db, {
          id: randomUUID(),
          tenantId: tenant.id,
          email: body.email,
          name: body.name ?? null,
          passwordHash
        });
        const issued = await issueDashboardSession(
          deps,
          deps.db,
          request,
          user.id
        );

        setSessionCookie(deps, reply, issued.token, issued.expiresAt);

        return reply.code(201).send({
          tenant: tenantDto(tenant),
          user: userDto(user),
          session: { expiresAt: issued.expiresAt.toISOString() },
          message:
            'Dashboard login created. Use the email and password to sign in on other devices.'
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw ApiError.conflict(
            'email_taken',
            'An account with this email already exists'
          );
        }
        throw error;
      }
    }
  );

  app.put('/auth/password', async (request) => {
    const auth = await readDashboardAuth(deps.db, request);
    if (!auth) throw ApiError.unauthorized('Dashboard login required');

    assertDashboardCsrf(request);

    const body = parseInput(ChangePasswordSchema, request.body);
    const matches = await verifyPassword(
      body.currentPassword,
      auth.user.passwordHash
    );
    if (!matches) {
      throw new ApiError(
        400,
        'invalid_current_password',
        'Current password is incorrect'
      );
    }

    const passwordHash = await hashPassword(body.newPassword);
    await updateUserPassword(deps.db, auth.user.id, passwordHash);
    await deleteOtherDashboardSessions(
      deps.db,
      auth.user.id,
      auth.session.id
    );

    return { changed: true };
  });
}
