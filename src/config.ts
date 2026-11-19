import { z } from 'zod';

const booleanFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  DATA_DIR: z.string().min(1).default('./data'),
  PUBLIC_URL: z.string().default(''),
  ADMIN_SECRET: z.string().default(''),
  PUBLIC_SIGNUP: booleanFromEnv(true),
  TRUST_PROXY: booleanFromEnv(false),
  CORS_ORIGINS: z.string().default(''),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  AUTO_MIGRATE: booleanFromEnv(true),
  DASHBOARD_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  COOKIE_SECURE: z.string().optional(),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  ALLOW_PRIVATE_MEDIA_URLS: booleanFromEnv(false),
  ALLOW_PRIVATE_WEBHOOKS: booleanFromEnv(false),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WA_SEND_INTERVAL_MS: z.coerce.number().int().positive().default(1_500),
  MAX_SESSIONS_PER_TENANT: z.coerce.number().int().positive().default(5),
  MAX_SESSIONS_TOTAL: z.coerce.number().int().positive().default(20),
  SESSION_MAX_RECONNECT_DELAY_MS: z.coerce.number().int().positive().default(30_000)
});

export type Config = Omit<z.infer<typeof EnvSchema>, 'COOKIE_SECURE'> & {
  COOKIE_SECURE: boolean;
  mediaDir: string;
  authDir: string;
  tmpDir: string;
  publicUrl: string;
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }

  const dataDir = parsed.data.DATA_DIR.replace(/\/+$/, '');
  const cookieSecure =
    parsed.data.COOKIE_SECURE === undefined || parsed.data.COOKIE_SECURE === ''
      ? parsed.data.NODE_ENV === 'production'
      : ['1', 'true', 'yes', 'on'].includes(
          parsed.data.COOKIE_SECURE.toLowerCase()
        );

  return {
    ...parsed.data,
    COOKIE_SECURE: cookieSecure,
    publicUrl: parsed.data.PUBLIC_URL.replace(/\/+$/, ''),
    mediaDir: `${dataDir}/media`,
    authDir: `${dataDir}/auth`,
    tmpDir: `${dataDir}/tmp`,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  };
}
