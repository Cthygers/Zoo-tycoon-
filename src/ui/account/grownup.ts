// The grown-up check (spec §3.3, P2): "Ask a grown-up: what is 14 × 7?" with a numeric keypad.
// Factors 12–19 × 6–9 (answers 72–171); 3 wrong answers lock it for 30 s. It guards removing a
// player, signing out and deleting the account. The gate logic is pure (tests/account-grownup);
// one shared gate per page keeps a lockout when the check is closed and opened again.
import { button, el } from '../dom';
import { cue } from '../sound';
import { openModal } from './dialog';

export const GATE_A_MIN = 12;
export const GATE_A_MAX = 19;
export const GATE_B_MIN = 6;
export const GATE_B_MAX = 9;
export const GATE_WRONG_LIMIT = 3;
export const GATE_LOCK_MS = 30_000;
/** Longest answer the keypad accepts (3 digits: 72..171). */
export const GATE_MAX_DIGITS = 3;

export interface GateQuestion {
  a: number;
  b: number;
  answer: number;
}

export type GateResult = 'ok' | 'wrong' | 'locked';

/** A question with a in 12..19 and b in 6..9. */
export function makeQuestion(random: () => number = Math.random): GateQuestion {
  const pick = (lo: number, hi: number) => lo + Math.min(hi - lo, Math.floor(Math.max(0, random()) * (hi - lo + 1)));
  const a = pick(GATE_A_MIN, GATE_A_MAX);
  const b = pick(GATE_B_MIN, GATE_B_MAX);
  return { a, b, answer: a * b };
}

export class GrownupGate {
  private q: GateQuestion;
  private wrong = 0;
  private lockedUntil = 0;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(opts: { now?: () => number; random?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.q = makeQuestion(this.random);
  }

  get question(): GateQuestion {
    if (this.lockedUntil && this.now() >= this.lockedUntil) this.unlock();
    return this.q;
  }

  /** Wrong answers since the last lockout / success. */
  get wrongCount(): number {
    return this.wrong;
  }

  /** Milliseconds of lockout left (0 = open). */
  lockedMs(): number {
    if (!this.lockedUntil) return 0;
    const left = this.lockedUntil - this.now();
    if (left <= 0) {
      this.unlock();
      return 0;
    }
    return left;
  }

  /** Check an answer. 'wrong' asks a new question; the 3rd wrong answer in a row locks the gate for 30 s. */
  submit(answer: number): GateResult {
    if (this.lockedMs() > 0) return 'locked';
    if (Number.isFinite(answer) && answer === this.q.answer) {
      this.wrong = 0;
      this.q = makeQuestion(this.random);
      return 'ok';
    }
    this.wrong += 1;
    this.q = makeQuestion(this.random);
    if (this.wrong >= GATE_WRONG_LIMIT) {
      this.lockedUntil = this.now() + GATE_LOCK_MS;
      return 'locked';
    }
    return 'wrong';
  }

  private unlock(): void {
    this.lockedUntil = 0;
    this.wrong = 0;
    this.q = makeQuestion(this.random);
  }
}

/** Keypad input: digits up to GATE_MAX_DIGITS, 'back' deletes one. */
export function typeKey(current: string, key: string): string {
  if (key === 'back') return current.slice(0, -1);
  if (/^[0-9]$/.test(key) && current.length < GATE_MAX_DIGITS) return current === '0' ? key : current + key;
  return current;
}

let shared: GrownupGate | null = null;

/** The page's one gate (a lockout survives closing and reopening the check). */
export function sharedGate(): GrownupGate {
  return (shared ??= new GrownupGate());
}

/** "Wait 25 seconds and ask a grown-up again." */
export function lockText(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return `Too many wrong answers. Wait ${s} ${s === 1 ? 'second' : 'seconds'} and ask a grown-up again.`;
}

/**
 * Show the check. Resolves true when a grown-up answered right, false on Cancel / back.
 * `why` names what it guards ("to remove Mia").
 */
export function askGrownup(root: HTMLElement, why: string, gate: GrownupGate = sharedGate()): Promise<boolean> {
  let typed = '';
  const q = el('div', { class: 'wh-ac-gate-q' });
  const ans = el('div', { class: 'wh-ac-gate-ans', attrs: { 'aria-live': 'polite' } });
  const msg = el('div', { class: 'wh-ac-err', attrs: { role: 'alert' } });
  let tick = 0;
  const draw = () => {
    const left = gate.lockedMs();
    const { a, b } = gate.question;
    q.textContent = `What is ${a} × ${b}?`;
    ans.textContent = typed || ' ';
    if (left > 0) {
      msg.textContent = lockText(left);
      keys.forEach((k) => (k.disabled = true));
      if (!tick) tick = window.setInterval(draw, 500);
    } else {
      if (msg.textContent?.startsWith('Too many')) msg.textContent = '';
      keys.forEach((k) => (k.disabled = false));
      okKey.disabled = typed.length === 0;
      if (tick) {
        window.clearInterval(tick);
        tick = 0;
      }
    }
  };
  const press = (k: string) => {
    typed = typeKey(typed, k);
    ans.classList.remove('bad');
    draw();
  };
  const submit = () => {
    if (!typed) return;
    const r = gate.submit(Number(typed));
    typed = '';
    if (r === 'ok') {
      m.close(true);
      return;
    }
    cue('deny');
    ans.classList.remove('bad');
    void ans.offsetWidth;
    ans.classList.add('bad');
    msg.textContent = r === 'locked' ? lockText(gate.lockedMs()) : 'Not quite. Try this one.';
    draw();
  };
  const digit = (d: string) => button('wh-btn-ghost', null, d, () => press(d), d);
  const okKey = button('wh-btn-primary ok', null, 'OK', submit, 'OK');
  const keys: HTMLButtonElement[] = [
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit),
    button('wh-btn-ghost', 'chevronLeft', null, () => press('back'), 'Delete'),
    digit('0'),
    okKey,
  ];
  const cancel = button('wh-btn-ghost', null, 'Cancel', () => m.close(false));
  const body = el('div', 'wh-ac-gate', [
    el('div', 'wh-ac-gate-l', [
      el('p', { text: `A grown-up needs to answer this ${why}.` }),
      q,
      ans,
      msg,
      el('div', 'wh-dialog-btns', [cancel]),
    ]),
    el('div', 'wh-ac-keys', keys),
  ]);
  const onKey = (e: KeyboardEvent) => {
    if (/^(Digit|Numpad)[0-9]$/.test(e.code)) press(e.code.slice(-1));
    else if (e.code === 'Backspace') press('back');
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') submit();
  };
  window.addEventListener('keydown', onKey);
  const m = openModal<boolean>(root, { title: 'Ask a grown-up', body, buttons: [], dismiss: { value: false }, wide: true, cls: 'wh-ac-gatebox' });
  draw();
  return m.done.finally(() => {
    window.removeEventListener('keydown', onKey);
    if (tick) window.clearInterval(tick);
  });
}
