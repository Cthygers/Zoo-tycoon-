// The sign-in sheet (spec §3.1, platform §10.4): one Google sign-in for the grown-up, kid words
// for every failure, silence on cancel.
import type { CloudHandle, SignInOutcome } from '../../core/cloud-types';
import { el } from '../dom';
import { openModal } from './dialog';

export const SIGNIN_TITLE = 'Save your zoos online';
export const SIGNIN_TEXT = 'Save your zoos online and play Versus with friends. A grown-up signs in once, then everyone picks their own player.';

/** The spec's kid words for each failure reason (the net layer's message when it has its own). */
export const SIGNIN_ERRORS = {
  offline: 'Connect to the internet to sign in',
  no_google: "Add a Google account in your phone's Settings to sign in",
  server: "Can't reach the Wildhaven server right now. You can keep playing.",
  not_allowed: "This Google account can't use Wildhaven online yet. Ask the grown-up who set it up.",
  unknown: "Sign-in didn't work. Try again.",
} as const;

/** What to show after a sign-in attempt: null for success and for a cancel (silent). */
export function signInErrorText(o: SignInOutcome): string | null {
  if (o.kind !== 'error') return null;
  if (o.reason === 'unknown' && o.message && o.message.trim()) return o.message;
  return SIGNIN_ERRORS[o.reason] ?? SIGNIN_ERRORS.unknown;
}

/**
 * Show the sheet; resolves with the outcome of the attempt that succeeded, or null when the
 * player chose "Not now". A cancelled Google sheet leaves this sheet open (no message).
 */
export function signInSheet(root: HTMLElement, cloud: Pick<CloudHandle, 'auth'>, opts: { text?: string } = {}): Promise<SignInOutcome | null> {
  const err = el('div', { class: 'wh-ac-err', attrs: { role: 'alert' } });
  const busy = el('div', 'wh-ac-busy', [el('span', 'wh-spin'), el('span', { text: 'Signing in…' })]);
  busy.style.display = 'none';
  const m = openModal<SignInOutcome | null>(root, {
    title: SIGNIN_TITLE,
    text: opts.text ?? SIGNIN_TEXT,
    body: el('div', {}, [err, busy]),
    buttons: [],
    dismiss: { value: null },
    cls: 'wh-ac-signin',
  });
  let running = false;
  const go = async () => {
    if (running) return;
    running = true;
    err.textContent = '';
    busy.style.display = '';
    btns.forEach((b) => (b.disabled = true));
    let out: SignInOutcome;
    try {
      out = await cloud.auth.signIn();
    } catch {
      out = { kind: 'error', reason: 'unknown', message: SIGNIN_ERRORS.unknown };
    }
    running = false;
    busy.style.display = 'none';
    btns.forEach((b) => (b.disabled = false));
    if (out.kind === 'ok') {
      m.close(out);
      return;
    }
    err.textContent = signInErrorText(out) ?? '';
  };
  const notNow = el('button', { class: 'wh-btn wh-btn-ghost', text: 'Not now', attrs: { type: 'button' }, onClick: () => !running && m.close(null) });
  const google = el('button', { class: 'wh-btn wh-btn-primary', attrs: { type: 'button' }, onClick: () => void go() }, [
    el('span', { class: 'wh-ac-g', html: GOOGLE_G }),
    el('span', { class: 'wh-btn-label', text: 'Continue with Google' }),
  ]);
  const btns = [notNow, google];
  m.box.append(el('div', 'wh-dialog-btns', btns));
  google.focus({ preventScroll: true });
  return m.done;
}

/** A plain "G" mark (not Google's logo) so the button reads as Google sign-in. */
const GOOGLE_G =
  '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#fff"/><text x="12" y="16.6" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="14" fill="#3c6e2c">G</text></svg>';
