import { defineConfig } from 'vite';

// base './' so the bundle loads from file:// / the Capacitor WebView.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The sim suites run whole game days; give them headroom when the machine is busy.
    testTimeout: 20_000,
  },
} as any);
