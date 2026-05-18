import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export const createDbClient = (url: string) => {
  const sql = postgres(url, { max: 10, prepare: false });
  return drizzle(sql);
};

export type DbClient = ReturnType<typeof createDbClient>;
