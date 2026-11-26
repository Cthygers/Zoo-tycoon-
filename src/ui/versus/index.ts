// The in-match versus UI (spec §5.7), plugged into the game UI as a UIExtension:
// - the two-line clock/score chip (≤ 150 px) in the HUD's speed slot, and its breakdown sheet;
// - the 3-2-1 countdown that swallows input ("Your zoo waited for you!");
// - point pops ("+30 Baby zebra!", "−25 …", "Day 7: +142 points");
// - Settings: "New zoo" hidden, "Give up this match";
// - the end: "Time's up!", then the results (crown, confetti, bars, chart) or "Waiting for Mia…",
//   with Look at my zoo (only once decided), Rematch!, Back to menu and the family hand-off.
import type { VersusParts } from '../../../shared/api-types';
import type { GameEvents } from '../../core/events';
import type { UIExtension, UIExtensionHost } from '../../core/ui-ext';
import type { VersusController } from '../../versus/controller';
import { button, el, escapeHtml, iconEl, setText, swallowPointer, toggleClass } from '../dom';
import { icon } from '../icons';
import { avatarEl } from './hub';
import { injectVersusStyles } from './styles';
import { biggestDifference, categoryRows, chartPaths, chipModel, fmtLeft, fmtPoints, resultModel, type ResultModel } from './view';

export { openVersusHub } from './hub';

const CONFETTI = ['#f2cf74', '#a6d17b', '#82bfd6', '#e88466', '#fff5d6', '#c99636'];
const SPEED_KEYS = new Set(['Space', 'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3']);

/** Block every pointer / wheel / touch on an overlay from reaching the map or the HUD under it. */
function swallowAll(e: HTMLElement): void {
  swallowPointer(e);
  for (const t of ['pointermove', 'pointerup', 'touchstart', 'touchmove'] as const) e.addEventListener(t, (ev) => ev.stopPropagation(), { passive: true });
}

function confetti(n = 32): HTMLElement {
  const conf = el('div', 'wh-confetti');
  for (let i = 0; i < n; i++) {
    const p = el('i');
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.3;
    const dist = 110 + Math.random() * 150;
    p.style.background = CONFETTI[i % CONFETTI.length];
    p.style.setProperty('--dx', `${(Math.cos(ang) * dist).toFixed(0)}px`);
    p.style.setProperty('--dy', `${(Math.sin(ang) * dist * 0.6 + 70).toFixed(0)}px`);
    p.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
    p.style.animationDelay = `${(Math.random() * 0.15).toFixed(2)}s`;
    conf.append(p);
  }
  return conf;
}

class VersusExtension implements UIExtension {
  readonly id = 'versus';
  private host!: UIExtensionHost;
  private chip!: HTMLButtonElement;
  private l1!: HTMLElement;
  private l2!: HTMLElement;
  private pops!: HTMLElement;
  private sheet: HTMLElement | null = null;
  private count: HTMLElement | null = null;
  private countNum: HTMLElement | null = null;
  private end: HTMLElement | null = null;
  private endState: 'none' | 'timesup' | 'results' | 'looking' = 'none';
  private endShownAt = 0;
  private lastResultKey = '';
  private chipAcc = 1;
  private sheetAcc = 0;
  private offs: (() => void)[] = [];
  private dirty = true;

  constructor(private readonly ctrl: VersusController) {}

  mount(host: UIExtensionHost): void {
    this.host = host;
    injectVersusStyles();
    this.l1 = el('span', 'wh-vs-l1');
    this.l2 = el('span', 'wh-vs-l2');
    this.chip = el('button', { class: 'wh-vs-chip wh-glass', attrs: { type: 'button', 'aria-label': 'Match score and time left' }, onClick: () => this.toggleSheet() }, [this.l1, this.l2]);
    swallowPointer(this.chip);
    host.hudSlot('speed').append(this.chip);
    this.pops = el('div', 'wh-vs-pops');
    host.root.append(this.pops);
    host.hideSettingsRow('newZoo', true);
    this.offs.push(
      host.addSettingsSection({ id: 'versus', order: 40, render: () => this.settingsSection() }),
      host.events.on('versusPoints', (p) => this.pop(p)),
      host.events.on('versusEnded', () => this.onEnded()),
      this.ctrl.onChange(() => (this.dirty = true)),
    );
    // a match opened after it ended (results not sent yet, or pending)
    if (this.ctrl.view()?.ended) this.onEnded(true);
    this.refreshChip();
  }

  update(dt: number): void {
    this.chipAcc += dt;
    if (this.chipAcc >= 0.25) {
      this.chipAcc = 0;
      this.refreshChip();
    }
    this.refreshCountdown();
    if (this.sheet) {
      this.sheetAcc += dt;
      if (this.sheetAcc >= 0.5) {
        this.sheetAcc = 0;
        this.fillSheet();
      }
    }
    if (this.endState === 'timesup' && performance.now() - this.endShownAt > 2600) this.showResults();
    if (this.dirty) {
      this.dirty = false;
      if (this.endState === 'results' || this.endState === 'looking') this.maybeRefreshResults();
    }
  }

  handleBack(): boolean {
    if (this.count) return true; // the countdown holds everything
    if (this.sheet) {
      this.closeSheet();
      return true;
    }
    if (this.endState === 'timesup') {
      this.showResults();
      return true;
    }
    if (this.endState === 'results') return true; // a button decides where to go
    return false;
  }

  onKey(code: string): boolean {
    if (this.count) return true;
    return SPEED_KEYS.has(code);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.chip?.remove();
    this.pops?.remove();
    this.sheet?.remove();
    this.count?.remove();
    this.end?.remove();
  }

  // ------------------------------------------------------------------ chip
  private refreshChip(): void {
    const v = this.ctrl.view();
    if (!v) return;
    const sim = this.host.sim;
    const m = chipModel({ timeLeftS: this.ctrl.timeLeftS(), ended: v.ended, day: sim.day, days: v.rules.days, me: v.total(), opp: this.ctrl.opponent() });
    const ico = m.lastNight ? 'moon' : 'clock';
    if (this.l1.dataset.ico !== ico) {
      this.l1.dataset.ico = ico;
      this.l1.innerHTML = `${icon(ico)}<span></span>`;
    }
    setText(this.l1.lastElementChild!, m.time);
    if (!this.l2.firstChild) this.l2.innerHTML = '<i class="wh-vs-dot"></i><span class="wh-vs-sc"></span>';
    setText(this.l2.lastElementChild!, m.score);
    toggleClass(this.chip, 'amber', m.amber);
    toggleClass(this.chip, 'night', m.lastNight);
    toggleClass(this.chip, 'live', m.live);
  }

  // ------------------------------------------------------------------ breakdown sheet
  private toggleSheet(): void {
    if (this.sheet) this.closeSheet();
    else this.openSheet();
  }

  private openSheet(): void {
    this.sheet = el('div', { class: 'wh-vs-sheet wh-glass-2', attrs: { role: 'dialog', 'aria-label': 'Zoo Points' } });
    swallowAll(this.sheet);
    this.host.root.append(this.sheet);
    this.fillSheet();
    this.host.audio.play('open');
  }

  private closeSheet(): void {
    this.sheet?.remove();
    this.sheet = null;
    this.host.audio.play('close');
  }

  private fillSheet(): void {
    const s = this.sheet;
    const v = this.ctrl.view();
    if (!s || !v) return;
    const opp = this.ctrl.opponent();
    const me = this.ctrl.player;
    const rows = categoryRows(v.parts(), opp?.parts ?? null);
    const who = (name: string, av: Parameters<typeof avatarEl>[0]) => el('div', 'wh-vs-who', [avatarEl(av, 28), el('span', { text: name })]);
    const close = button('wh-btn-ghost wh-btn-icon', 'close', null, () => this.closeSheet(), 'Close');
    close.style.cssText = 'width: 36px; min-width: 36px; height: 36px; min-height: 36px;';
    const head = el('div', 'wh-vs-sheet-h', [el('b', { text: 'Zoo Points' }), who('You', me.avatar), who(opp?.name ?? '—', opp?.avatar ?? null), close]);
    const fmt = (n: number | null) => (n === null ? '—' : fmtPoints(n));
    const lines = rows.map((r) => {
      const lead = r.them !== null && r.me > r.them;
      return el('div', 'wh-vs-sheet-r', [
        el('div', 'wh-vs-cat', [iconEl(r.icon), el('div', '', [el('b', { text: r.label }), el('small', { text: r.tip })])]),
        el('span', { class: `wh-vs-n${lead ? ' lead' : ''}`, text: fmt(r.me) }),
        el('span', { class: 'wh-vs-n', text: fmt(r.them) }),
      ]);
    });
    const today = v.todayPoints();
    const them = opp ? (opp.atMyHour ?? opp.total) : null;
    const foot = el('div', 'wh-vs-sheet-f', [
      el('span', { html: `Today: <b>${today >= 0 ? '+' : '−'}${fmtPoints(Math.abs(today))}</b>` }),
      el('span', { html: `Total: <b>${fmtPoints(v.total())}</b> vs <b>${them === null ? '—' : fmtPoints(them)}</b>` }),
    ]);
    const tip = el('div', { class: 'wh-vs-note', text: 'Need a break? Press Home — your zoo waits. The match clock keeps running.' });
    tip.style.marginTop = '6px';
    s.replaceChildren(head, ...lines, foot, tip);
  }

  // ------------------------------------------------------------------ countdown
  private refreshCountdown(): void {
    const c = this.ctrl.countdown();
    if (!c) {
      if (this.count) {
        this.count.remove();
        this.count = this.countNum = null;
      }
      return;
    }
    if (!this.count) {
      const minutes = Math.max(1, Math.round(this.ctrl.timeLeftS() / 60));
      const title = c.first ? 'Get ready…' : 'Your zoo waited for you!';
      const sub = c.first ? 'Most Zoo Points wins!' : `Time left to play: ${minutes} min`;
      this.countNum = el('div', 'wh-vs-num');
      this.count = el('div', { class: 'wh-vs-layer wh-vs-count', attrs: { role: 'status', 'aria-live': 'assertive' } }, [el('h3', { text: title }), this.countNum, el('p', { text: sub })]);
      swallowAll(this.count);
      this.count.addEventListener('click', (e) => e.stopPropagation());
      this.closeSheet();
      this.host.root.append(this.count);
    }
    const text = c.go ? 'Go!' : String(Math.max(1, Math.ceil(c.left)));
    if (this.countNum && this.countNum.textContent !== text) {
      this.countNum.textContent = text;
      toggleClass(this.countNum, 'go', c.go);
      // restart the tick animation for each number
      this.countNum.style.animation = 'none';
      void this.countNum.offsetWidth;
      this.countNum.style.animation = '';
      this.host.audio.play(c.go ? 'build' : 'tap');
    }
    if (c.go) this.count.style.pointerEvents = 'none';
  }

  // ------------------------------------------------------------------ pops
  private pop(p: GameEvents['versusPoints']): void {
    const sign = p.delta >= 0 ? '+' : '−';
    const text = p.part === 'money' ? (p.text ?? `${sign}${fmtPoints(Math.abs(p.delta))} points today`) : `${sign}${fmtPoints(Math.abs(p.delta))} ${p.text ?? ''}`.trim();
    const kind = p.part === 'money' ? 'day' : p.delta < 0 ? 'bad' : 'good';
    const e = el('div', { class: `wh-vs-pop wh-glass ${kind}`, text });
    this.pops.append(e);
    while (this.pops.childElementCount > 3) this.pops.firstElementChild?.remove();
    window.setTimeout(() => e.remove(), 2700);
  }

  // ------------------------------------------------------------------ settings
  private settingsSection(): HTMLElement {
    const give = button('wh-btn-danger', 'close', 'Give up', async () => {
      const ok = await this.host.showDialog({ title: 'Give up?', text: 'Give up? The other player wins.', ok: 'Give up', cancel: 'Keep playing', danger: true, primary: 'cancel' });
      if (!ok) return;
      const r = await this.ctrl.giveUp();
      if (r === 'offline') this.host.notify('You need the internet for this. Ask a grown-up to connect to Wi-Fi.', 'warn');
      else if (r === 'error') this.host.notify('Something went wrong. Try again.', 'bad');
    });
    const ended = !!this.ctrl.view()?.ended;
    if (ended) give.disabled = true;
    return el('div', 'wh-setting', [
      el('div', { class: 'wh-setting-t', html: `<b>Give up this match</b><span>The match clock keeps running while you are away.</span>` }),
      give,
    ]);
  }

  // ------------------------------------------------------------------ end of the match
  private onEnded(quiet = false): void {
    if (this.endState !== 'none') return;
    this.closeSheet();
    this.refreshChip();
    if (quiet) {
      this.showResults();
      return;
    }
    const v = this.ctrl.view();
    const day = this.host.sim.day;
    const line = v?.endReason === 'budget' ? `Your zoo reached day ${Math.min(day, v.rules.days)}.` : `All ${v?.rules.days ?? ''} zoo days are done!`;
    this.end = el('div', { class: 'wh-vs-layer wh-vs-end' }, [el('div', 'wh-vs-endcard wh-vs-timesup wh-glass-2', [el('h2', { text: "Time's up!" }), el('div', { class: 'wh-vs-line', text: line })])]);
    swallowAll(this.end);
    this.end.addEventListener('click', () => this.showResults());
    this.host.root.append(this.end);
    this.endState = 'timesup';
    this.endShownAt = performance.now();
    this.host.audio.play('celebrate');
  }

  private resultNow(): ResultModel {
    const v = this.ctrl.view();
    const p = this.ctrl.player;
    const ob = this.ctrl.outbox();
    const offline = ob.pending > 0 && !ob.dead;
    return resultModel(this.ctrl.lost() ? null : this.ctrl.match(), { name: p.name ?? 'You', avatar: p.avatar, total: v?.total() ?? 0 }, { offline, dead: !!ob.dead });
  }

  private maybeRefreshResults(): void {
    const r = this.resultNow();
    const key = `${r.outcome}|${r.line}|${r.them?.total ?? ''}`;
    if (key === this.lastResultKey) return;
    if (this.endState === 'looking') {
      // decided while looking at the zoo: say so, the results come back with a tap on the chip
      if (r.decided) this.host.notify(r.title, r.outcome === 'won' || r.outcome === 'tie' ? 'good' : 'info');
      this.lastResultKey = key;
      return;
    }
    this.showResults();
  }

  private showResults(): void {
    const r = this.resultNow();
    this.lastResultKey = `${r.outcome}|${r.line}|${r.them?.total ?? ''}`;
    this.end?.remove();
    this.endState = 'results';
    const v = this.ctrl.view();
    const myParts: VersusParts = v?.parts() ?? { v: 0, a: 0, s: 0, b: 0, m: 0, l: 0 };
    const opp = this.ctrl.opponent();
    const card = el('div', 'wh-vs-endcard wh-glass-2');
    const head: HTMLElement[] = [el('h2', { text: r.title }), el('div', { class: 'wh-vs-line', text: r.line })];
    if (this.ctrl.lost()) head[1].textContent = 'This match was lost. Your zoo is kept as practice.';
    const side = (s: { name: string; avatar: ResultModel['me']['avatar']; total: number | null; crown: boolean }, h: number) => {
      const step = el('div', { class: 'wh-vs-step', text: s.total === null ? '…' : fmtPoints(s.total) });
      step.style.height = `${h}px`;
      return el('div', 'wh-vs-side', [
        s.crown ? el('span', { class: 'wh-vs-crown', html: icon('crown') }) : null,
        avatarEl(s.avatar, 56),
        el('b', { text: s.name }),
        step,
      ]);
    };
    const meT = r.me.total;
    const themT = r.them?.total ?? null;
    const top = Math.max(1, meT, themT ?? 0);
    const podium = el('div', 'wh-vs-podium', [side(r.me, 24 + 40 * (meT / top)), r.them ? side(r.them, 24 + 40 * ((themT ?? 0) / top)) : null]);
    const right: HTMLElement[] = [];
    const themParts = r.decided ? (opp?.parts ?? null) : null;
    if (r.decided || !r.them) {
      const rows = categoryRows(myParts, themParts);
      const max = Math.max(1, ...rows.map((x) => Math.max(Math.abs(x.me), Math.abs(x.them ?? 0))));
      const bars = el(
        'div',
        'wh-vs-bars',
        rows.map((x) => {
          const bar = (cls: 'me' | 'them', n: number | null) => {
            const b = el('div', `wh-vs-b ${cls}`);
            if (n !== null) b.innerHTML = `<i style="width:${((Math.abs(n) / max) * 100).toFixed(1)}%"></i><em>${escapeHtml(fmtPoints(n))}</em>`;
            return b;
          };
          return el('div', { class: 'wh-vs-bar', title: x.label }, [iconEl(x.icon), bar('me', x.me), bar('them', x.them)]);
        }),
      );
      right.push(bars);
      const diff = biggestDifference(myParts, themParts, r.them?.name ?? 'Them');
      if (diff) right.push(el('div', { class: 'wh-vs-note', text: diff }));
    }
    const series = this.ctrl.mySeries();
    if (series.length > 1) {
      const theirs = this.ctrl.oppSeries().map((row) => [row[0], row[1]] as const);
      const W = 300;
      const H = 70;
      const p = chartPaths(series, r.decided ? theirs : [], v?.hoursTotal ?? 1, W, H);
      const svg = `<svg class="wh-vs-chart" viewBox="-2 -4 ${W + 4} ${H + 8}" preserveAspectRatio="none" aria-label="Points over time"><path class="them" d="${p.them}" fill="none" stroke-width="2.5" stroke-linejoin="round"/><path class="me" d="${p.me}" fill="none" stroke-width="3" stroke-linejoin="round"/></svg>`;
      right.push(el('div', { html: svg }));
    }
    if (r.close) right.push(el('div', { class: 'wh-vs-close', text: 'Close match!' }));
    const grid = el('div', 'wh-vs-endgrid', [podium, el('div', '', right)]);
    const btns: HTMLElement[] = [];
    const fam = !r.decided ? this.ctrl.familyNext() : null;
    if (fam) btns.push(button('wh-btn-primary', 'users', `Now it's ${fam.name}'s turn!`, () => void this.ctrl.passTo(fam.profileId)));
    if (r.decided) {
      btns.push(button('wh-btn-ghost', 'eye', 'Look at my zoo', () => this.lookAtZoo()));
      if (!this.ctrl.lost()) btns.push(button('wh-btn-primary', 'refresh', 'Rematch!', () => void this.rematch(btns)));
    }
    btns.push(button(r.decided || fam ? 'wh-btn-ghost' : 'wh-btn-primary', 'home', 'Back to menu', () => void this.ctrl.backToMenu()));
    card.append(...head, grid);
    if (fam) card.append(el('div', { class: 'wh-vs-note', text: `Pass the phone to ${fam.name}` }));
    card.append(el('div', 'wh-vs-endbtns', btns));
    if (r.me.confetti) card.append(confetti());
    this.end = el('div', { class: 'wh-vs-layer wh-vs-end' }, [card]);
    swallowAll(this.end);
    this.host.root.append(this.end);
    if (!r.decided) this.ctrl.refresh();
    if (r.decided && (r.outcome === 'won' || r.outcome === 'tie')) this.host.audio.play('celebrate');
  }

  private async rematch(btns: HTMLElement[]): Promise<void> {
    for (const b of btns) (b as HTMLButtonElement).disabled = true;
    const r = await this.ctrl.rematch();
    for (const b of btns) (b as HTMLButtonElement).disabled = false;
    if (r === 'offline') this.host.notify('You need the internet to start a challenge. Ask a grown-up to connect to Wi-Fi.', 'warn');
    else if (r === 'error') this.host.notify('Something went wrong. Try again.', 'bad');
  }

  /** V5: only once the result is decided. Closes the overlay; the zoo stays frozen; the chip brings it back. */
  private lookAtZoo(): void {
    this.end?.remove();
    this.end = null;
    this.endState = 'looking';
    const reopen = (e: Event) => {
      if (this.endState !== 'looking') return;
      e.stopImmediatePropagation();
      this.showResults();
    };
    this.chip.addEventListener('click', reopen, { capture: true });
    this.host.notify('Tap the score to see the results again.', 'info');
  }
}

export function createVersusExtension(ctrl: VersusController): UIExtension {
  return new VersusExtension(ctrl);
}

/** Exposed for the harness: the chip text for a given state (no DOM). */
export { chipModel, fmtLeft };
