import { buildServer } from './server.js';
import { env } from './env.js';

const main = async (): Promise<void> => {
  const server = await buildServer();
  try {
    await server.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
};

void main();
