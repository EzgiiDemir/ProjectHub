import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts', 'apps/worker/test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Integration suites share one PostgreSQL database; run files sequentially.
    fileParallelism: false,
    pool: 'forks',
  },
});
