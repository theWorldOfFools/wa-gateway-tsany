import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { getSession } from '../../repos/sessions.js';
import type { HttpDeps } from '../deps.js';
import { parseInput } from '../validation.js';

const ParamsSchema = z.object({ id: z.string().min(1) });

export function registerGroupRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/groups',
    async (request) => {
      const { id } = parseInput(ParamsSchema, request.params);
      const session = await getSession(deps.db, request.tenant!.id, id);
      if (!session) throw ApiError.notFound('Session not found');

      const groups = await deps.manager.listGroups(session);
      return { data: groups };
    }
  );

  app.get<{ Params: { id: string; jid: string } }>(
    '/sessions/:id/groups/:jid',
    async (request) => {
      const { id, jid } = parseInput(
        z.object({ id: z.string().min(1), jid: z.string().min(1) }),
        request.params
      );
      const session = await getSession(deps.db, request.tenant!.id, id);
      if (!session) throw ApiError.notFound('Session not found');

      const group = await deps.manager.getGroup(session, jid);
      return { group };
    }
  );
}
