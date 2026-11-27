import { defineConfig } from 'vitest/config';

// Tests des modules purs uniquement (data/) : aucun module natif n'est chargé.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['data/**/*.test.ts'],
  },
});
