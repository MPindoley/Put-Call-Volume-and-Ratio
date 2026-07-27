import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure computation modules plus route handlers that can be called directly
    // (no DOM needed; DB-backed specs self-skip unless RUN_DB_TESTS=1).
    include: ['src/lib/**/*.test.ts', 'src/app/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
