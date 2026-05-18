import { coreEnvSchema, parseEnv } from '@pkg/env';

export const env = parseEnv(coreEnvSchema);
export type Env = typeof env;
