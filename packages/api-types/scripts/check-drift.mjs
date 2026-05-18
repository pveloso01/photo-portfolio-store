import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'api-types-'));
const out = join(tmp, 'generated.ts');
const res = spawnSync('npx', ['openapi-typescript', '../../openapi.yaml', '-o', out], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (res.status !== 0) process.exit(res.status ?? 1);
const fresh = readFileSync(out, 'utf8');
const committed = readFileSync('src/generated.ts', 'utf8');
if (fresh !== committed) {
  console.error(
    'packages/api-types/src/generated.ts is out of date. Run `pnpm codegen` and commit.',
  );
  process.exit(1);
}
console.log('api-types is in sync with openapi.yaml');
