import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logger. Secret-bearing fields are redacted wherever they appear. */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'password',
        '*.password',
        'token',
        '*.token',
        'value',
        'credential',
        '*.credential',
        'accessToken',
        '*.accessToken',
        'req.headers.cookie',
        'req.headers.authorization',
        'headers.cookie',
        'headers.authorization',
      ],
      censor: '[redacted]',
    },
  });
}
