// The account UI's overlay layer and modal dialogs. The layer sits above the title menu, the
// loading screen and the game UI (sync prompts can appear while the zoo is loading), and keeps
// one stack of open modals for Android back / Esc. Dialogs reuse the shell's look
// (.wh-dialog-back, .wh-dialog, .wh-glass-2, .wh-dialog-btns, .wh-btn).
import type { Avatar } from '../../../shared/api-types';
import { avatarSvg } from '../avatars';
import { button, el, swallowPointer } from '../dom';
import { icon, type IconName } from '../icons';
import { cue } from '../sound';
import { ensureAccountStyles } from './styles';

const layers = new WeakMap<HTMLElement, HTMLElement>();

/** The fixed overlay layer for `root` (created on first use). */
export function accountLayer(root: HTMLElement): HTMLElement {
  ensureAccountStyles();
  let l = layers.get(root);
  if (!l || !l.isConnected) {
    l = el('div', { class: 'wh-screen wh-ac-layer', attrs: { 'data-wh-ac': 'layer' } });
    root.append(l);
    layers.set(root, l);
  }
  return l;
}

export interface ModalButton<T> {
  label: string;
  value: T;
  style?: 'primary' | 'ghost' | 'danger';
  icon?: IconName;
}

export interface ModalOpts<T> {
  title: string;
  text?: string;
  /** Extra content between the text and the buttons. */
  body?: HTMLElement;
  /** Buttons left to right (the primary one last, as the shell's dialogs do). Empty: the body brings its own. */
  buttons: ModalButton<T>[];
  /** Value for Esc / Android back / a tap outside; absent = they do nothing (a choice is required). */
  dismiss?: { value: T };
  wide?: boolean;
  cls?: string;
}

export interface ModalHandle<T> {
  readonly done: Promise<T>;
  readonly box: HTMLElement;
  close(v: T): void;
}

interface OpenModal {
  back(): boolean;
}

const stack: OpenModal[] = [];

/** Close the top-most account modal the way Esc would (Android back). False when none is open or it needs a choice. */
export function closeTopModal(): boolean {
  const m = stack[stack.length - 1];
  if (!m) return false;
  m.back();
  return true;
}

export function modalOpen(): boolean {
  return stack.length > 0;
}

/** Open a modal in the account layer of `root`. */
export function openModal<T>(root: HTMLElement, o: ModalOpts<T>): ModalHandle<T> {
  const layer = accountLayer(root);
  let resolve!: (v: T) => void;
  const done = new Promise<T>((r) => (resolve = r));
  const back = el('div', { class: 'wh-dialog-back', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title } });
  const box = el('div', `wh-dialog wh-glass-2 wh-ac-dialog${o.wide ? ' wide' : ''}${o.cls ? ` ${o.cls}` : ''}`, [
    el('h3', { text: o.title }),
    o.text ? el('p', { text: o.text }) : null,
    o.body ?? null,
  ]);
  let closed = false;
  const entry: OpenModal = {
    back() {
      if (!o.dismiss) return true; // a choice is required: back is swallowed
      close(o.dismiss.value);
      return true;
    },
  };
  const close = (v: T) => {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    back.remove();
    window.removeEventListener('keydown', onKey, true);
    resolve(v);
  };
  const onKey = (e: KeyboardEvent) => {
    if (stack[stack.length - 1] !== entry) return;
    if (e.code === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (o.dismiss) {
        cue('close');
        close(o.dismiss.value);
      }
    } else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !(e.target instanceof HTMLInputElement)) {
      const primary = o.buttons.find((b) => b.style === 'primary');
      if (primary) {
        e.stopPropagation();
        e.preventDefault();
        close(primary.value);
      }
    }
  };
  if (o.buttons.length) {
    const btns = o.buttons.map((b) => button(`wh-btn-${b.style ?? 'ghost'}`, b.icon ?? null, b.label, () => close(b.value)));
    box.append(el('div', 'wh-dialog-btns', btns));
  }
  back.append(box);
  back.addEventListener('click', (ev) => {
    if (ev.target === back && o.dismiss) close(o.dismiss.value);
  });
  swallowPointer(back);
  window.addEventListener('keydown', onKey, true);
  stack.push(entry);
  layer.append(back);
  cue('open');
  const focus = box.querySelector<HTMLElement>('.wh-btn-primary') ?? box.querySelector<HTMLElement>('.wh-btn');
  focus?.focus({ preventScroll: true });
  return { done, box, close };
}

/** A one-button notice. */
export function notice(root: HTMLElement, title: string, text: string | undefined, ok = 'OK'): Promise<void> {
  return openModal<void>(root, { title, text, buttons: [{ label: ok, value: undefined, style: 'primary' }], dismiss: { value: undefined } }).done;
}

/** A two-button confirm; resolves true for OK. */
export function confirmBox(root: HTMLElement, o: { title: string; text?: string; ok: string; cancel?: string; danger?: boolean; body?: HTMLElement; primary?: 'ok' | 'cancel' }): Promise<boolean> {
  const cancelPrimary = o.primary === 'cancel';
  const okBtn: ModalButton<boolean> = { label: o.ok, value: true, style: o.danger ? 'danger' : cancelPrimary ? 'ghost' : 'primary' };
  const cancelBtn: ModalButton<boolean> = { label: o.cancel ?? 'Cancel', value: false, style: cancelPrimary ? 'primary' : 'ghost' };
  return openModal<boolean>(root, {
    title: o.title,
    text: o.text,
    body: o.body,
    buttons: cancelPrimary ? [okBtn, cancelBtn] : [cancelBtn, okBtn],
    dismiss: { value: false },
  }).done;
}

/** A small "working…" modal; call the returned function to close it. */
export function busyBox(root: HTMLElement, title: string, text = 'One moment…'): () => void {
  const body = el('div', 'wh-ac-busy', [el('span', 'wh-spin'), el('span', { text })]);
  const m = openModal<null>(root, { title, body, buttons: [] });
  return () => m.close(null);
}

let toastTimer = 0;

/** A short message at the top of the screen (sync prompts' toast). */
export function showToast(root: HTMLElement, text: string, ico: IconName = 'cloudCheck'): void {
  const layer = accountLayer(root);
  layer.querySelector('.wh-ac-toast')?.remove();
  window.clearTimeout(toastTimer);
  const t = el('div', { class: 'wh-ac-toast wh-glass-2', attrs: { role: 'status' } }, [el('span', { html: icon(ico) }), el('span', { text })]);
  layer.append(t);
  toastTimer = window.setTimeout(() => {
    t.classList.add('out');
    window.setTimeout(() => t.remove(), 450);
  }, 3600);
}

/** An avatar disc (a person glyph for the guest). */
export function avatarEl(a: Avatar | null, size: number, cls = ''): HTMLElement {
  const s = el('span', { class: `wh-ac-av${a ? '' : ' guest'}${cls ? ` ${cls}` : ''}`, attrs: { 'aria-hidden': 'true' } });
  s.style.width = s.style.height = `${size}px`;
  s.innerHTML = a ? avatarSvg(a, size) : icon('user');
  return s;
}

/** The kid-friendly message of a rejection (FriendlyError.message), else a generic line. */
export function errorText(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m.trim() && !/^\w*Error$/.test(m) && !/^[a-z_]+$/.test(m) ? m : fallback;
}

export interface Page {
  readonly root: HTMLElement;
  readonly head: HTMLElement;
  readonly body: HTMLElement;
  close(): void;
}

const pages: { back: () => boolean }[] = [];

/** Android back / Esc for the top-most account page; false when none is open. */
export function closeTopPage(): boolean {
  const p = pages[pages.length - 1];
  return p ? p.back() : false;
}

/**
 * A full-screen page (picker, manage players, setup, whose zoo, backups) in `container`.
 * `onBack` adds the round back button and answers Esc / Android back; without it the page
 * needs a choice.
 */
export function openPage(container: HTMLElement, o: { title: string; cls?: string; onBack?: () => void; headExtra?: HTMLElement[] }): Page {
  const head = el('div', 'wh-ac-head', [
    o.onBack ? button('wh-btn-ghost wh-btn-icon', 'chevronLeft', null, () => o.onBack?.(), 'Back') : null,
    el('h2', { text: o.title }),
    ...(o.headExtra ?? []),
  ]);
  const body = el('div', 'wh-ac-body');
  const root = el('div', { class: `wh-screen wh-ac-page${o.cls ? ` ${o.cls}` : ''}`, attrs: { role: 'dialog', 'aria-label': o.title } }, [el('div', 'wh-ac-col', [head, body])]);
  swallowPointer(root);
  const entry = {
    back: () => {
      if (o.onBack) o.onBack();
      return true;
    },
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Escape' || pages[pages.length - 1] !== entry || modalOpen()) return;
    e.stopPropagation();
    if (o.onBack) o.onBack();
  };
  window.addEventListener('keydown', onKey);
  pages.push(entry);
  container.append(root);
  return {
    root,
    head,
    body,
    close() {
      const i = pages.indexOf(entry);
      if (i >= 0) pages.splice(i, 1);
      window.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}
