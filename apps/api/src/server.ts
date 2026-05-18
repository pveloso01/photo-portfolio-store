import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import sensible from '@fastify/sensible';

export const buildServer = async (): Promise<FastifyInstance> => {
  const logLevel = process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV === 'development';

  const opts: FastifyServerOptions = isDev
    ? {
        logger: {
          level: logLevel,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        },
        disableRequestLogging: false,
      }
    : {
        logger: { level: logLevel },
        disableRequestLogging: false,
      };

  const app = Fastify(opts);

  await app.register(sensible);

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/', async () => ({ name: 'photo-portfolio-store api', ok: true }));

  return app;
};
