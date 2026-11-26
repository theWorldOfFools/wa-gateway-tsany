import 'fastify';
import type { AuthMethod, Tenant } from '../domain.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
    apiKeyId?: string;
    authMethod?: AuthMethod;
    userId?: string;
    dashboardSessionId?: string;
    metricsStart?: number;
  }
}
