import pino, { type LoggerOptions } from 'pino';
import { coreEnvSchema, parseEnv } from '@pkg/env';

const env = parseEnv(coreEnvSchema);

const baseOptions: LoggerOptions = { level: env.LOG_LEVEL };
const loggerOptions: LoggerOptions =
  env.NODE_ENV === 'development'
    ? {
        ...baseOptions,
        transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } },
      }
    : baseOptions;

const logger = pino(loggerOptions);

logger.info({ env: env.NODE_ENV }, 'worker booted; idle (queues land in M1)');

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

setInterval(() => {
  // heartbeat will be replaced by BullMQ workers in M1
}, 60_000).unref();

await new Promise<void>(() => {});
