import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-admin-secret"]',
        'body.apiKey',
        'body.secret'
      ],
      censor: '[redacted]'
    }
  });
}
