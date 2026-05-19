import { defineConfig } from 'vitest/config';

// Integration suite — separate from the unit suite so `pnpm test` stays fast.
// Container start-up dominates first-run cost (~30-60s); subsequent runs reuse
// the container by label.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    globalSetup: ['./test/setup.testcontainers.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
