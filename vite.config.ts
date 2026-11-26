import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/** versionName of the Android app (android/app/build.gradle), shown in Settings and sent to the server. */
function appVersion(): string {
  try {
    const gradle = readFileSync(new URL('./android/app/build.gradle', import.meta.url), 'utf8');
    return /versionName\s+"([^"]+)"/.exec(gradle)?.[1] ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The fake Google sign-in is for tests and e2e only: never let it into a release bundle. */
function refuseFakeGoogle(...values: Array<string | undefined>): void {
  if (values.some((v) => (v ?? '').trim() !== '')) {
    throw new Error('VITE_FAKE_GOOGLE_URL must not be set for production builds');
  }
}

// base './' so the bundle loads from file:// / the Capacitor WebView.
export default defineConfig(({ mode }) => {
  if (mode === 'production') {
    refuseFakeGoogle(process.env.VITE_FAKE_GOOGLE_URL, loadEnv(mode, process.cwd(), 'VITE_').VITE_FAKE_GOOGLE_URL);
  }
  // Backstop for a build run with another root or envDir: check the env Vite itself resolved.
  const fakeGoogleGuard: Plugin = {
    name: 'wildhaven:no-fake-google-in-production',
    configResolved(config) {
      if (config.mode === 'production') refuseFakeGoogle(config.env.VITE_FAKE_GOOGLE_URL as string | undefined);
    },
  };
  return {
    base: './',
    plugins: [fakeGoogleGuard],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion()),
    },
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
  } as any;
});
