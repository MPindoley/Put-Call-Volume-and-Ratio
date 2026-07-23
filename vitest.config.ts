import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests cover the pure computation modules only; no DOM/DB needed.
    include: ['src/lib/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
