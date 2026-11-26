// Google sign-in (spec §3.1). Native: @capgo/capacitor-social-login through a dynamic import (the web and
// test bundles never load it), exactly as the spec shows. On the web it reports unavailable, except the
// e2e/dev fake issuer when VITE_FAKE_GOOGLE_URL is set: GET {url}/token?sub&email&aud&nonce, with the
// user picked by ?fakeSub= (default parent1).
import type { GoogleSignIn } from '../core/cloud-types';
import { FAKE_GOOGLE_URL, WEB_CLIENT_ID } from './config';

/** Thrown by getIdToken when the phone has no Google account / Play services. */
export class NoGoogleAccountError extends Error {
  constructor(message = 'No Google account on this device') {
    super(message);
    this.name = 'NoGoogleAccountError';
  }
}

export function createGoogleSignIn(): GoogleSignIn {
  if (FAKE_GOOGLE_URL) return fakeGoogleSignIn(FAKE_GOOGLE_URL, WEB_CLIENT_ID);
  return nativeGoogleSignIn(WEB_CLIENT_ID);
}

type SocialLoginModule = typeof import('@capgo/capacitor-social-login');

export function nativeGoogleSignIn(webClientId: string): GoogleSignIn {
  let mod: Promise<SocialLoginModule['SocialLogin']> | null = null;
  const plugin = () => {
    if (!mod) {
      mod = (async () => {
        const { SocialLogin } = await import('@capgo/capacitor-social-login');
        await SocialLogin.initialize({ google: { webClientId, mode: 'online', skipAuthOnlyAuthorizationAfterSignIn: true } });
        return SocialLogin;
      })();
      mod.catch(() => {
        mod = null;
      });
    }
    return mod;
  };
  return {
    async available() {
      if (!webClientId) return false;
      try {
        const { Capacitor } = await import('@capacitor/core');
        return Capacitor.isNativePlatform();
      } catch {
        return false;
      }
    },
    async getIdToken(nonce: string) {
      const SocialLogin = await plugin();
      try {
        const res = await SocialLogin.login({ provider: 'google', options: { nonce, style: 'standard', filterByAuthorizedAccounts: false } });
        const r = res.result as { idToken?: string | null };
        return r.idToken ? { idToken: r.idToken } : null;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        if (err?.code === 'USER_CANCELLED' || /cancel/i.test(err?.message ?? '')) return null;
        if (/no credential|no google account|no account|NoCredential/i.test(err?.message ?? '')) throw new NoGoogleAccountError(err.message);
        throw e;
      }
    },
    async signOut() {
      try {
        const SocialLogin = await plugin();
        await SocialLogin.logout({ provider: 'google' });
      } catch {
        /* nothing to sign out of */
      }
    },
  };
}

/** e2e/dev only: the local fake issuer signs real RS256 tokens the server verifies normally. */
export function fakeGoogleSignIn(url: string, aud: string, fetchFn: typeof fetch = (...a) => fetch(...a)): GoogleSignIn {
  const pick = () => {
    let sub = 'parent1';
    try {
      const q = new URLSearchParams(globalThis.location?.search ?? '').get('fakeSub');
      if (q && /^[A-Za-z0-9_.-]{1,64}$/.test(q)) sub = q;
    } catch {
      /* no location (tests) */
    }
    return sub;
  };
  return {
    async available() {
      return true;
    },
    async getIdToken(nonce: string) {
      const sub = pick();
      const q = new URLSearchParams({ sub, email: `${sub}@example.com`, aud: aud || 'e2e-web-client', nonce });
      const res = await fetchFn(`${url.replace(/\/+$/, '')}/token?${q.toString()}`);
      if (!res.ok) throw new Error(`fake Google answered ${res.status}`);
      const body = (await res.json()) as { idToken?: string };
      return body.idToken ? { idToken: body.idToken } : null;
    },
    async signOut() {
      /* nothing to do */
    },
  };
}
