import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
      `.tsx` is included for packages too. The design system lives in a package and its components
      are React, so a `.tsx` test there was silently *not collected* — the file ran nowhere and
      the suite reported green. Only the desktop app's tests caught the omission because its
      pattern already had the extension.
    */
    include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    environment: 'node',
    // Renderer tests opt into jsdom with a `@vitest-environment jsdom` docblock.
    testTimeout: 30000,
  },
});
