import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    environment: 'node',
    // Renderer tests opt into jsdom with a `@vitest-environment jsdom` docblock.
    testTimeout: 30000,
  },
});
