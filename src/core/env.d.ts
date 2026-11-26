// Build-time environment of the app (Vite). See spec §8.8 and setup-checklist.md.
// Without VITE_API_BASE the game makes no network request: no sign-in, profiles, sync or Versus.

interface ImportMetaEnv {
  /** Base URL of the Wildhaven API server, e.g. https://zoo-api.example.com (the client adds /v1). */
  readonly VITE_API_BASE?: string;
  /** Google OAuth Web client id: the server's audience and the sign-in plugin's webClientId (public, not a secret). */
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
  /** Local fake Google sign-in page for tests and e2e; vite.config.ts refuses it in production builds. */
  readonly VITE_FAKE_GOOGLE_URL?: string;
  /** '1' allows the versus test length (2 zoo days, 4 real minutes); the server must run in test mode too. Dev only. */
  readonly VITE_VERSUS_TEST?: string;
}

/** versionName of android/app/build.gradle, injected by vite.config.ts (define). */
declare const __APP_VERSION__: string;
