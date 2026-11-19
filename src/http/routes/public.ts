import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/index.js';
import { ApiError } from '../../errors.js';
import { verifyAdminSecret } from '../auth.js';
import type { HttpDeps } from '../deps.js';
import { parseInput } from '../validation.js';
import { createApiKey } from '../../repos/apiKeys.js';
import { createTenant } from '../../repos/tenants.js';
import { generateApiKey } from '../../security/apiKey.js';

const RegisterSchema = z.object({
  name: z.string().trim().min(2).max(80)
});

export function registerPublicRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post(
    '/tenants',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' }
      }
    },
    async (request, reply) => {
      const body = parseInput(RegisterSchema, request.body);

      const allowed =
        deps.config.PUBLIC_SIGNUP ||
        verifyAdminSecret(deps.config, request.headers['x-admin-secret']);
      if (!allowed) {
        throw ApiError.forbidden(
          'Tenant signup is disabled. Provide a valid x-admin-secret header.'
        );
      }

      const tenantId = randomUUID();
      const apiKeyId = randomUUID();
      const generated = generateApiKey();

      const client = await deps.db.connect();
      try {
        await client.query('BEGIN');
        const tenant = await createTenant(
          client as unknown as Db,
          tenantId,
          body.name
        );
        await createApiKey(client as unknown as Db, {
          id: apiKeyId,
          tenantId,
          name: 'default',
          keyPrefix: generated.prefix,
          keyHash: generated.hash,
          scopes: ['*']
        });
        await client.query('COMMIT');

        return reply.code(201).send({
          tenant: {
            id: tenant.id,
            name: tenant.name,
            createdAt: tenant.createdAt.toISOString()
          },
          apiKey: {
            id: apiKeyId,
            name: 'default',
            key: generated.key,
            prefix: generated.prefix
          },
          warning:
            'Store the API key securely. It is only shown once and cannot be recovered.'
        });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  );
}
