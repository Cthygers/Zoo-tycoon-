// Build-time cloud configuration (spec §8.8, setup checklist). Without VITE_API_BASE the game makes
// no network request at all: no sign-in, profiles, sync or Versus (spec §1 rule 1).

/** API origin without a trailing slash, e.g. https://zoo-api.example.com ('' = cloud disabled). */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').trim().replace(/\/+$/, '');
/** Google OAuth Web client id: the plugin's webClientId and the server's audience (public). */
export const WEB_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID ?? '').trim();
/** Local fake Google issuer for tests and e2e (refused in production builds by vite.config.ts). */
export const FAKE_GOOGLE_URL: string = (import.meta.env.VITE_FAKE_GOOGLE_URL ?? '').trim().replace(/\/+$/, '');
/** The versus test length (4 min) is offered (dev only, the server must allow it too). */
export const VERSUS_TEST: boolean = import.meta.env.VITE_VERSUS_TEST === '1';
export const cloudEnabled: boolean = API_BASE !== '';
