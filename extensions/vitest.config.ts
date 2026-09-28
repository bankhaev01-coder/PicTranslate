import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';
import { fileURLToPath } from 'url';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

