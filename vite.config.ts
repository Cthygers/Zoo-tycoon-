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
  },
} as any);
