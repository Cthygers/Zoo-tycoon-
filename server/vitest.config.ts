import { defineConfig } from 'vitest/config';

// Server tests run in-process (app.inject), each file on its own temp SQLite file.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
