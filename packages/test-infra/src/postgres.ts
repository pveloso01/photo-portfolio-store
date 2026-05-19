// Postgres testcontainer wrapper. Spins up postgres:16-alpine with a fixed
// db / user / password so callers can hand the URL to drizzle migrations and
// the app's createDbClient().
//
// We deliberately enable container reuse (TESTCONTAINERS_REUSE_ENABLE=true)
// to make repeat local runs fast — the container is left behind between
// `pnpm test:integration` invocations and picked back up by label.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface StartedPostgres {
  readonly container: StartedPostgreSqlContainer;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

const IMAGE = 'postgres:16-alpine';
const DB = 'photo_test';
const USER = 'photo';
const PASSWORD = 'photo';

export const startPostgres = async (): Promise<StartedPostgres> => {
  const container = await new PostgreSqlContainer(IMAGE)
    .withDatabase(DB)
    .withUsername(USER)
    .withPassword(PASSWORD)
    .withReuse()
    .start();

  // testcontainers gives us host/port/db/user/password — assemble a URL
  // postgres-js understands. Disable prepared statements + use a small pool.
  const url = `postgres://${USER}:${PASSWORD}@${container.getHost()}:${container.getMappedPort(
    5432,
  )}/${DB}`;

  return {
    container,
    url,
    stop: async () => {
      await container.stop();
    },
  };
};
