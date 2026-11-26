// The Versus hub (spec §5.7): opened from the title menu for a signed-in player. Challenge a
// friend (length → code → share), join with a code (six big boxes), play with family, the
// cached list of my matches and each match's lobby. Resolves with the MenuResult to boot
// ('versus' to play a match, 'tutorial' for "Learn first"), or null when the player goes back.
import type { Avatar, CodePreviewResponse, MatchDto, VersusLength } from '../../../shared/api-types';
import { CODE_ALPHABET, CODE_LENGTH, VERSUS_RULES_VERSION, codeHasLookalikes, formatCode, isValidCode, lengthSpec, normalizeCode } from '../../../shared/versus-rules';
import type { CloudHandle } from '../../core/cloud-types';
import type { MenuResult, PlayerInfo } from '../../core/contracts';
import type { KV } from '../../core/player-state';
import { vsSlot } from '../../core/storage-keys';
import { markIndexSeen, readIndex, readRecord, upsertIndex, writeIndex } from '../../versus/record';

export { versusNeedsAttention } from '../../versus/record';
import { avatarSvg } from '../avatars';
import { button, el, escapeHtml, iconEl } from '../dom';
import { icon, type IconName } from '../icons';
import { injectVersusStyles } from './styles';
import { budgetLabel, deadlineText, fmtMinutes, fmtPoints, lengthLabel, myTurn, seatOf, shareText, statusChip } from './view';

export type HubScreen = 'hub' | 'challenge' | 'code' | 'join' | 'family' | 'lobby';

export interface VersusHubDeps {
  cloud: CloudHandle;
  player: PlayerInfo;
  tutorialDone: boolean;
  /** Harness / test seams: the store of the cached list (localStorage), the clock, a screen to open on. */
  storage?: KV;
  now?: () => number;
  start?: { screen: HubScreen; match?: MatchDto; code?: string };
}

const DEFAULT_LENGTHS: VersusLength[] = [30, 60, 90, 120];
const LOOKALIKE_HINT = "Codes don't use O, 0, I, 1 or L — check the letter";

function storageOf(deps: VersusHubDeps): KV {
  if (deps.storage) return deps.storage;
  try {
    return localStorage;
  } catch {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  }
}

/** An avatar disc (a "?" disc when there is nobody yet). */
export function avatarEl(a: Avatar | null, size: number): HTMLElement {
  const s = el('span', { class: 'wh-vs-av', attrs: { 'aria-hidden': 'true' } });
  s.style.width = s.style.height = `${size}px`;
  if (a) s.innerHTML = avatarSvg(a, size);
  else {
    s.style.cssText += `background: rgba(255,255,255,.1); border: 2px dashed rgba(255,255,255,.3); display: grid; place-items: center; font-weight: 900; font-size: ${Math.round(size * 0.45)}px; color: rgba(255,255,255,.55); line-height: 1;`;
    s.textContent = '?';
  }
  return s;
}

function errorText(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m && !/^\w+Error$/.test(m) ? m : fallback;
}

/** "Day 12 · 860" / "Ready" / "Finished 1,240" for a seat in the lobby. */
function seatLine(s: MatchDto['players'][number] | null): string {
  if (!s) return 'Waiting for a friend';
  if (s.state === 'invited') return 'Invited';
  if (s.state === 'done' || s.doneAt !== null) return s.endReason === 'forfeit' ? 'Gave up' : `Finished · ${fmtPoints(s.total)}`;
  if (s.lastHour > 0) return `Day ${1 + Math.floor((510 + 60 * s.lastHour) / 1440)} · ${fmtPoints(s.total)}`;
  return 'Ready';
}

class Hub {
  readonly root: HTMLElement;
  private page = el('div', 'wh-vs-page');
  private readonly store: KV;
  private readonly now: () => number;
  private readonly pid: string;
  private resolve!: (r: MenuResult | null) => void;
  readonly done: Promise<MenuResult | null>;
  private matches: MatchDto[];
  private online: boolean | null = null;
  private screen: HubScreen = 'hub';
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.back();
    }
  };

  constructor(
    parent: HTMLElement,
    private readonly deps: VersusHubDeps,
  ) {
    injectVersusStyles();
    this.store = storageOf(deps);
    this.now = deps.now ?? (() => Date.now());
    this.pid = deps.player.profileId ?? deps.player.ref;
    this.matches = readIndex(this.store, this.pid).matches;
    this.root = el('div', { class: 'wh-screen wh-vs', attrs: { role: 'dialog', 'aria-label': 'Versus' } }, [this.page]);
    parent.append(this.root);
    this.done = new Promise((r) => (this.resolve = r));
    window.addEventListener('keydown', this.onKey);
  }

  // ------------------------------------------------------------------ navigation
  finish(r: MenuResult | null): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
    this.resolve(r);
  }

  back(): void {
    if (this.root.querySelector('.wh-vs-modal-back')) {
      this.root.querySelector('.wh-vs-modal-back')?.remove();
      return;
    }
    if (this.screen === 'hub') this.finish(null);
    else this.showHub();
  }

  play(m: MatchDto): void {
    this.finish({ kind: 'versus', player: this.deps.player.ref, slot: vsSlot(m.id), matchId: m.id });
  }

  private frame(title: string, body: HTMLElement[], foot: HTMLElement[] = []): void {
    const back = button('wh-btn-ghost wh-vs-back', 'chevronLeft', null, () => this.back(), this.screen === 'hub' ? 'Back to the menu' : 'Back');
    const p = this.deps.player;
    const me = el('span', 'wh-vs-me', [avatarEl(p.avatar, 34), el('span', { text: p.name ?? '' })]);
    const head = el('div', 'wh-vs-head', [back, el('h2', { text: title }), me]);
    const content = el('div', 'wh-vs-body', body);
    this.page.replaceChildren(head, content, ...(foot.length ? [el('div', 'wh-vs-foot', foot)] : []));
  }

  // ------------------------------------------------------------------ hub
  showHub(): void {
    this.screen = 'hub';
    const v = this.deps.cloud.versus;
    const others = this.familyPlayers();
    const card = (ic: IconName, tone: string, title: string, sub: string, fn: () => void, disabled = false) => {
      const b = el('button', { class: `wh-vs-card${disabled ? ' disabled' : ''}`, attrs: { type: 'button' }, onClick: () => (disabled ? undefined : fn()) }, [
        el('span', { class: `wh-vs-ic ${tone}`, html: icon(ic) }),
        el('div', '', [el('b', { text: title }), el('span', { text: sub })]),
      ]);
      return b;
    };
    const cards = el('div', 'wh-vs-cards', [
      card('trophy', 'gold', 'Challenge a friend', 'Pick a time, get a code', () => this.showChallenge()),
      card('key', 'sky', 'Join with a code', "Type your friend's code", () => this.showJoin()),
      card('users', 'leaf', 'Play with family', others.length ? 'Someone on this account' : 'Add another player first', () => this.showFamily(), !others.length),
    ]);
    const note = el('small', { text: this.online === false ? 'Offline — saved list' : '' });
    const list = el('div', 'wh-vs-list');
    const body: HTMLElement[] = [cards, el('div', 'wh-vs-h3', [el('span', { text: 'My matches' }), note]), list];
    if (!v.available) body.unshift(el('div', { class: 'wh-vs-empty', text: 'Sign in to play Versus.' }));
    this.frame('Versus', body);
    this.fillList(list);
    void this.refreshList(list, note);
    if (!this.deps.tutorialDone && !this.prompted) {
      this.prompted = true;
      this.tutorialPrompt();
    }
  }
  private prompted = false;

  private fillList(list: HTMLElement): void {
    const now = this.now();
    const ms = [...this.matches].sort((a, b) => Number(myTurn(b)) - Number(myTurn(a)) || b.createdAt - a.createdAt);
    if (!ms.length) {
      list.replaceChildren(el('div', { class: 'wh-vs-empty', text: 'No matches yet. Challenge a friend to start one!' }));
      return;
    }
    list.replaceChildren(
      ...ms.map((m) => {
        const them = seatOf(m, false);
        let dead = false;
        try {
          dead = !!this.deps.cloud.versus.outboxState(m.id).dead;
        } catch {
          dead = false;
        }
        const chip = statusChip(m, now, dead);
        const title = them && them.state !== 'invited' ? `vs ${them.name}` : m.code ? `Your challenge ${formatCode(m.code)}` : m.kind === 'rematch' && them ? `Rematch with ${them.name}` : 'Your challenge';
        const sub = [lengthLabel(m.lengthMin, m.days), chip.sub].filter(Boolean).join(' · ');
        return el('button', { class: 'wh-vs-row', attrs: { type: 'button', 'data-match': m.id }, onClick: () => this.showLobby(m) }, [
          avatarEl(them && them.state !== 'invited' ? them.avatar : (them?.avatar ?? null), 44),
          el('div', 'wh-vs-row-t', [el('b', { text: title }), el('span', { text: sub })]),
          el('span', { class: `wh-vs-pill ${chip.tone}`, text: chip.text }),
        ]);
      }),
    );
  }

  private async refreshList(list: HTMLElement, note: HTMLElement): Promise<void> {
    const v = this.deps.cloud.versus;
    if (!v.available) return;
    try {
      const ms = await v.list(this.pid, 'all');
      this.matches = ms;
      this.online = true;
      writeIndex(this.store, this.pid, ms, this.now());
      note.textContent = '';
    } catch {
      this.online = false;
      note.textContent = 'Offline — saved list';
    }
    if (this.screen === 'hub' && list.isConnected) this.fillList(list);
  }

  private remember(m: MatchDto): void {
    this.matches = [m, ...this.matches.filter((x) => x.id !== m.id)];
    upsertIndex(this.store, this.pid, m, this.now());
  }

  private tutorialPrompt(): void {
    const close = () => back.remove();
    const back = el('div', 'wh-vs-modal-back', [
      el('div', { class: 'wh-vs-modal wh-glass-2', attrs: { role: 'alertdialog' } }, [
        el('h3', { text: 'Learn the basics first? It takes about 10 minutes.' }),
        el('p', { text: 'In Versus, time always runs fast. Learning first helps you win!' }),
        el('div', 'wh-vs-foot', [
          button('wh-btn-primary', 'star', 'Learn first', () => this.finish({ kind: 'tutorial', player: this.deps.player.ref, slot: 'practice' })),
          button('wh-btn-ghost', 'swords', 'Play anyway', close),
        ]),
      ]),
    ]);
    this.root.append(back);
  }

  // ------------------------------------------------------------------ challenge
  private lengths(): VersusLength[] {
    const cfg = this.deps.cloud.versus.config();
    const ls = cfg?.versusLengths?.length ? cfg.versusLengths : DEFAULT_LENGTHS;
    return ls.filter((l) => lengthSpec(l, true) !== null);
  }

  private lengthPicker(onPick: (l: VersusLength) => void): { el: HTMLElement; value(): VersusLength } {
    const ls = this.lengths();
    let cur = ls[0];
    const cards = ls.map((l) => {
      const spec = lengthSpec(l, true)!;
      const days = el('span', 'wh-vs-days');
      for (let i = 0; i < Math.min(15, spec.days); i++) days.append(el('i'));
      const b = el('button', { class: `wh-vs-len${l === cur ? ' on' : ''}`, attrs: { type: 'button', 'data-len': String(l) }, onClick: () => pick(l) }, [
        el('b', { text: fmtMinutes(l) }),
        el('span', { text: `${spec.days} zoo days` }),
        days,
        el('small', { text: budgetLabel(spec.budgetMin) }),
      ]);
      return b;
    });
    const pick = (l: VersusLength) => {
      cur = l;
      cards.forEach((c, i) => c.classList.toggle('on', ls[i] === l));
      onPick(l);
    };
    return { el: el('div', 'wh-vs-lengths', cards), value: () => cur };
  }

  showChallenge(): void {
    this.screen = 'challenge';
    const err = el('div', 'wh-vs-err');
    const picker = this.lengthPicker(() => (err.textContent = ''));
    const go = button('wh-btn-primary wh-vs-big', 'trophy', 'Make my challenge!', async () => {
      go.disabled = true;
      err.className = 'wh-vs-err hint';
      err.textContent = 'Making your challenge…';
      try {
        const m = await this.deps.cloud.versus.create({ profileId: this.pid, lengthMin: picker.value(), rulesVersion: VERSUS_RULES_VERSION });
        this.remember(m);
        this.showCode(m);
      } catch (e) {
        err.className = 'wh-vs-err';
        err.textContent = errorText(e, 'You need the internet to start a challenge. Ask a grown-up to connect to Wi-Fi.');
        go.disabled = false;
      }
    });
    this.frame('Challenge a friend', [el('div', { class: 'wh-vs-note', text: 'How long will you play?' }), picker.el, err], [go]);
  }

  // ------------------------------------------------------------------ code
  showCode(m: MatchDto): void {
    this.screen = 'code';
    const code = m.code ?? '';
    const msg = el('div', 'wh-vs-err hint');
    const share = button('wh-btn-ghost wh-vs-big', 'share', 'Share', () => void this.share(code, msg));
    const copy = button('wh-btn-ghost wh-vs-big', 'copy', 'Copy', () => void this.copy(code, msg));
    const canCancel = this.canCancel(m);
    const cancel = canCancel
      ? el('button', {
          class: 'wh-vs-link',
          text: 'Cancel this challenge',
          attrs: { type: 'button' },
          onClick: async () => {
            try {
              const c = await this.deps.cloud.versus.cancel(m.id, this.pid);
              this.remember(c);
              this.showHub();
            } catch (e) {
              msg.className = 'wh-vs-err';
              msg.textContent = errorText(e);
            }
          },
        })
      : null;
    this.frame(
      'Your challenge code',
      [
        el('div', 'wh-vs-codebox', [
          el('p', { text: 'Tell your friend this code!' }),
          el('div', { class: 'wh-vs-code', text: formatCode(code), attrs: { 'data-code': code } }),
          el('p', { text: `${lengthLabel(m.lengthMin, m.days)} · the code works for 2 days` }),
        ]),
        el('div', 'wh-vs-foot', [share, copy]),
        msg,
        ...(cancel ? [el('div', 'wh-vs-foot', [cancel])] : []),
      ],
      [button('wh-btn-primary', 'play1', 'Start playing now', () => this.play(m)), button('wh-btn-ghost', 'chevronLeft', 'Back to matches', () => this.showHub())],
    );
  }

  /** Cancel only while open and before the challenger's first play (V4). */
  private canCancel(m: MatchDto): boolean {
    if (m.status !== 'open' || m.mySeat !== 0) return false;
    const me = seatOf(m, true);
    if (!me || me.lastHour > 0 || me.device) return false;
    return readRecord(this.store, this.pid, m.id)?.budget.firstGoAt == null;
  }

  private async share(code: string, msg: HTMLElement): Promise<void> {
    const text = shareText(code);
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: 'Wildhaven Zoo', text, dialogTitle: 'Send your code' });
      return;
    } catch {
      /* no share sheet here: try the browser's, then copy */
    }
    try {
      const nav = navigator as Navigator & { share?: (d: { text: string; title?: string }) => Promise<void> };
      if (nav.share) {
        await nav.share({ title: 'Wildhaven Zoo', text });
        return;
      }
    } catch {
      /* cancelled or not allowed */
    }
    await this.copy(code, msg);
  }

  private async copy(code: string, msg: HTMLElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(formatCode(code));
      msg.className = 'wh-vs-err hint';
      msg.textContent = 'Copied! Now paste it in a message to your friend.';
    } catch {
      msg.className = 'wh-vs-err hint';
      msg.textContent = `Your code is ${formatCode(code)}`;
    }
  }

  // ------------------------------------------------------------------ join
  showJoin(prefill = ''): void {
    this.screen = 'join';
    const msg = el('div', 'wh-vs-err');
    const preview = el('div');
    const boxes: HTMLInputElement[] = [];
    let lastLooked = '';
    const value = () => boxes.map((b) => b.value).join('');
    const check = async () => {
      const code = value();
      if (code.length < CODE_LENGTH || !isValidCode(code)) {
        preview.replaceChildren();
        return;
      }
      if (code === lastLooked) return;
      lastLooked = code;
      msg.className = 'wh-vs-err hint';
      msg.textContent = 'Looking for the challenge…';
      try {
        const p = await this.deps.cloud.versus.preview(code, this.pid);
        if (value() !== code) return;
        this.showPreview(p, code, preview, msg);
      } catch (e) {
        if (value() !== code) return;
        msg.className = 'wh-vs-err';
        msg.textContent = errorText(e, "That code doesn't work — check the letters");
        preview.replaceChildren();
      }
    };
    const put = (from: number, raw: string) => {
      if (codeHasLookalikes(raw)) {
        msg.className = 'wh-vs-err hint';
        msg.textContent = LOOKALIKE_HINT;
      } else if (msg.textContent === LOOKALIKE_HINT) msg.textContent = '';
      const chars = [...normalizeCode(raw)].filter((c) => CODE_ALPHABET.includes(c));
      let i = from;
      for (const c of chars) {
        if (i >= CODE_LENGTH) break;
        boxes[i].value = c;
        i++;
      }
      if (!chars.length) boxes[from].value = '';
      // all six in: put the keyboard away so the preview shows
      if (value().length === CODE_LENGTH) (document.activeElement as HTMLElement | null)?.blur?.();
      else boxes[Math.min(i, CODE_LENGTH - 1)].focus();
      void check();
    };
    for (let i = 0; i < CODE_LENGTH; i++) {
      const b = el('input', {
        attrs: { type: 'text', inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '6', 'aria-label': `Letter ${i + 1}` },
      });
      b.addEventListener('input', () => put(i, b.value));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !b.value && i > 0) {
          boxes[i - 1].value = '';
          boxes[i - 1].focus();
          preview.replaceChildren();
          e.preventDefault();
        }
        e.stopPropagation();
      });
      b.addEventListener('focus', () => b.select());
      boxes.push(b);
    }
    const row = el('div', 'wh-vs-boxes', [...boxes.slice(0, 3), el('span', 'wh-vs-dash'), ...boxes.slice(3)]);
    this.frame('Join with a code', [el('div', { class: 'wh-vs-note', text: "Type your friend's code" }), row, msg, preview]);
    if (prefill) put(0, prefill);
    else setTimeout(() => boxes[0].focus(), 50);
  }

  private showPreview(p: CodePreviewResponse, code: string, box: HTMLElement, msg: HTMLElement): void {
    msg.textContent = '';
    if (p.status !== 'open') {
      msg.className = 'wh-vs-err';
      msg.textContent = p.status === 'active' ? 'Someone already joined this one' : 'This challenge has ended';
      box.replaceChildren();
      return;
    }
    const accept = button('wh-btn-primary wh-vs-big', 'check', 'Accept!', async () => {
      accept.disabled = true;
      try {
        const m = await this.deps.cloud.versus.join(p.matchId, { profileId: this.pid, code: normalizeCode(code), rulesVersion: VERSUS_RULES_VERSION });
        this.remember(m);
        this.showLobby(m);
      } catch (e) {
        msg.className = 'wh-vs-err';
        msg.textContent = errorText(e, "That code doesn't work — check the letters");
        accept.disabled = false;
      }
    });
    box.replaceChildren(
      el('div', 'wh-vs-preview', [
        avatarEl(p.challenger.avatar, 56),
        el('div', 'wh-vs-pv', [el('div', { html: `<b>${escapeHtml(p.challenger.name)}</b> challenges you!` }), el('span', { text: lengthLabel(p.lengthMin, p.days) })]),
        accept,
      ]),
    );
  }

  // ------------------------------------------------------------------ family
  private familyPlayers(): { id: string; name: string; avatar: Avatar }[] {
    try {
      return this.deps.cloud.profiles
        .list()
        .filter((p) => p.id !== this.pid)
        .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar }));
    } catch {
      return [];
    }
  }

  /** Two steps: who (big player tiles), then how long. */
  showFamily(whoId: string | null = null): void {
    this.screen = 'family';
    const people = this.familyPlayers();
    const who = people.find((p) => p.id === whoId) ?? (people.length === 1 ? people[0] : null);
    if (!who) {
      const tiles = people.map((p) =>
        el('button', { class: 'wh-vs-person', attrs: { type: 'button', 'data-pid': p.id }, onClick: () => this.showFamily(p.id) }, [avatarEl(p.avatar, 64), el('b', { text: p.name })]),
      );
      this.frame('Play with family', [el('div', { class: 'wh-vs-note', text: 'Who do you play against?' }), el('div', 'wh-vs-people', tiles)]);
      return;
    }
    const err = el('div', 'wh-vs-err');
    const picker = this.lengthPicker(() => (err.textContent = ''));
    const go = button('wh-btn-primary wh-vs-big', 'swords', `Play against ${who.name}!`, async () => {
      go.disabled = true;
      try {
        const m = await this.deps.cloud.versus.create({ profileId: this.pid, lengthMin: picker.value(), opponentProfileId: who.id, rulesVersion: VERSUS_RULES_VERSION });
        this.remember(m);
        this.showLobby(m);
      } catch (e) {
        err.className = 'wh-vs-err';
        err.textContent = errorText(e, 'You need the internet to start a match. Ask a grown-up to connect to Wi-Fi.');
        go.disabled = false;
      }
    });
    const vs = el('div', 'wh-vs-note', [el('span', { text: 'How long will you play?' })]);
    this.frame(`You vs ${who.name}`, [vs, picker.el, err], [go]);
  }

  // ------------------------------------------------------------------ lobby
  showLobby(m: MatchDto): void {
    this.screen = 'lobby';
    const now = this.now();
    const me = seatOf(m, true);
    const them = seatOf(m, false);
    const joined = them && them.state !== 'invited' ? them : null;
    const side = (s: typeof me, fallbackName: string, avatar: Avatar | null) =>
      el('div', 'wh-vs-side', [avatarEl(avatar, 64), el('b', { text: s?.name ?? fallbackName }), el('span', { text: seatLine(s) })]);
    let dead = false;
    try {
      dead = !!this.deps.cloud.versus.outboxState(m.id).dead;
    } catch {
      dead = false;
    }
    const chip = statusChip(m, now, dead);
    const middle = el('div', 'wh-vs-mid', [el('span', { class: 'wh-vs-vs', text: 'vs' }), el('span', { class: `wh-vs-pill ${chip.tone}`, text: chip.text })]);
    const body: HTMLElement[] = [
      el('div', 'wh-vs-face', [side(me, this.deps.player.name ?? 'You', me?.avatar ?? this.deps.player.avatar), middle, side(joined, them?.name ?? 'Waiting for a friend', joined?.avatar ?? them?.avatar ?? null)]),
    ];
    const deadline = myTurn(m) ? deadlineText(m.finishBy, now) : null;
    const code = m.status === 'open' && m.code ? ` · Your code: <b>${escapeHtml(formatCode(m.code))}</b>` : '';
    body.push(el('div', 'wh-vs-meta', [el('span', { html: `<b>${escapeHtml(lengthLabel(m.lengthMin, m.days))}</b> · ${escapeHtml(budgetLabel(m.budgetMin))}${code}` })]));
    if (deadline) body.push(el('div', { class: 'wh-vs-note', text: deadline }));
    // the first match ever: three rules
    if (this.matches.filter((x) => x.id !== m.id).length === 0 && myTurn(m)) {
      const rule = (ic: IconName, t: string) => el('div', 'wh-vs-rule', [iconEl(ic), el('span', { text: t })]);
      body.push(el('div', 'wh-vs-rules', [rule('home', 'Same zoo start'), rule('clock', "Time can't be stopped — it runs fast!"), rule('trophy', 'Most Zoo Points wins')]));
    }
    const msg = el('div', 'wh-vs-err');
    body.push(msg);
    const foot: HTMLElement[] = [];
    const elsewhere = me?.device && !me.device.here;
    const playable = myTurn(m) && !elsewhere && m.rulesVersion <= VERSUS_RULES_VERSION;
    if (playable) foot.push(button('wh-btn-primary', 'play1', 'Play!', () => this.play(m)));
    if (m.status === 'open' && m.code) foot.push(button('wh-btn-ghost', 'share', 'Share code', () => void this.share(m.code!, msg)));
    foot.push(button('wh-btn-ghost', 'chevronLeft', 'Back to matches', () => this.showHub()));
    if (myTurn(m)) foot.push(el('button', { class: 'wh-vs-link', text: 'Give up', attrs: { type: 'button' }, onClick: () => this.confirmGiveUp(m, msg) }));
    this.frame(m.kind === 'family' ? 'Family match' : 'Match', body, foot);
  }

  private confirmGiveUp(m: MatchDto, msg: HTMLElement): void {
    const back = el('div', 'wh-vs-modal-back', [
      el('div', { class: 'wh-vs-modal wh-glass-2', attrs: { role: 'alertdialog' } }, [
        el('h3', { text: 'Give up? The other player wins.' }),
        el('div', 'wh-vs-foot', [
          button('wh-btn-primary', 'swords', 'Keep playing', () => back.remove()),
          button('wh-btn-danger', 'close', 'Give up', async () => {
            back.remove();
            try {
              const f = await this.deps.cloud.versus.forfeit(m.id, this.pid);
              this.remember(f);
              this.showHub();
            } catch (e) {
              msg.className = 'wh-vs-err';
              msg.textContent = errorText(e, 'You need the internet for this. Ask a grown-up to connect to Wi-Fi.');
            }
          }),
        ]),
      ]),
    ]);
    this.root.append(back);
  }

  open(): void {
    markIndexSeen(this.store, this.pid, this.now());
    const s = this.deps.start;
    if (!s || s.screen === 'hub') return this.showHub();
    this.prompted = true;
    if (s.screen === 'challenge') this.showChallenge();
    else if (s.screen === 'join') this.showJoin(s.code ?? '');
    else if (s.screen === 'family') this.showFamily();
    else if (s.screen === 'code' && s.match) this.showCode(s.match);
    else if (s.screen === 'lobby' && s.match) this.showLobby(s.match);
    else this.showHub();
  }
}

/** Open the Versus hub over `root`; resolves with what to boot, or null for Back. */
export function openVersusHub(root: HTMLElement, deps: VersusHubDeps): Promise<MenuResult | null> {
  const hub = new Hub(root, deps);
  hub.open();
  return hub.done;
}
