import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure computation modules, the client store's selectors, and route handlers
    // that can be called directly (no DOM needed; DB-backed specs self-skip
    // unless RUN_DB_TESTS=1).
    include: ['src/lib/**/*.test.ts', 'src/store/**/*.test.ts', 'src/app/**/*.test.ts'],
    environment: 'node',
    // The DB-backed specs share one throwaway database and each wipes it:
    // run files one at a time when they are enabled.
    fileParallelism: process.env.RUN_DB_TESTS !== '1',
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
