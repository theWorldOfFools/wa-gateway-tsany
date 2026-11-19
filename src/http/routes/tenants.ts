import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import type { HttpDeps } from '../deps.js';
import { apiKeyDto } from '../dto.js';
import { parseInput } from '../validation.js';
import {
  countActiveApiKeys,
  createApiKey,
  listApiKeys,
  revokeApiKey
} from '../../repos/apiKeys.js';
import { generateApiKey } from '../../security/apiKey.js';

const CreateKeySchema = z.object({
  name: z.string().trim().min(1).max(80).default('api-key')
});

export function registerTenantRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.get('/me', async (request) => {
    const tenant = request.tenant!;
    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        createdAt: tenant.createdAt.toISOString()
      },
      apiKeyId: request.apiKeyId,
      authMethod: request.authMethod ?? 'api_key',
      userId: request.userId ?? null
    };
  });

  app.get('/api-keys', async (request) => {
    const keys = await listApiKeys(deps.db, request.tenant!.id);
    return { data: keys.map(apiKeyDto) };
  });

  app.post('/api-keys', async (request, reply) => {
    const body = parseInput(CreateKeySchema, request.body ?? {});
    const generated = generateApiKey();
    const key = await createApiKey(deps.db, {
      id: randomUUID(),
      tenantId: request.tenant!.id,
      name: body.name,
      keyPrefix: generated.prefix,
      keyHash: generated.hash,
      scopes: ['*']
    });

    return reply.code(201).send({
      apiKey: {
        ...apiKeyDto(key),
        key: generated.key
      },
      warning:
        'Store the API key securely. It is only shown once and cannot be recovered.'
    });
  });

  app.delete<{ Params: { id: string } }>('/api-keys/:id', async (request, reply) => {
    const tenantId = request.tenant!.id;
    const keys = await listApiKeys(deps.db, tenantId);
    const target = keys.find((key) => key.id === request.params.id);
    if (!target) throw ApiError.notFound('API key not found');

    if (!target.revokedAt) {
      const active = await countActiveApiKeys(deps.db, tenantId);
      if (active <= 1) {
        throw ApiError.conflict(
          'last_api_key',
          'Cannot revoke the last active API key'
        );
      }
    }

    await revokeApiKey(deps.db, tenantId, target.id);
    return reply.code(204).send();
  });
}
