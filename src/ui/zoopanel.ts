// Zoo menu: finances (ledger, daily chart, admission price), goals, statistics,
// recent messages and settings (graphics quality, sound, save, new game).
// Refreshes at ~2 Hz while open.

import { AUDIO_PREFS_KEY, parsePrefs, serializePrefs, type AudioPrefs } from '../audio/prefs';
import { QUALITY_KEY, SOUND_KEY } from '../core/constants';
import type { AudioChannel, IAudio, IRenderContext, ISimulation, PlayerInfo, QualityLevel, RunningCostEstimate } from '../core/contracts';
import type { LedgerEntry } from '../core/types';
import type { SettingsSection } from '../core/ui-ext';
import { button, el, escapeHtml, fmtClock, fmtMoney, fmtPct, setText, storageGet, storageSet, swallowPointer, toggleClass } from './dom';
import { goalFraction, goalProgressText } from './coach';
import { guestChip } from './hud';
import { icon, type IconName } from './icons';
import { UnreadBadge, type MessageLog } from './notify';
import { logoSvg } from './screens';
import { showDialog } from './panels';
import { cue } from './sound';

export type ZooTab = 'finance' | 'goals' | 'stats' | 'messages' | 'settings';

/** What a save did: written, skipped for the showcase zoo, skipped to keep an unreadable old save, or failed (reported by main). */
export type SaveOutcome = 'saved' | 'showcase' | 'kept' | 'failed';

/** Toast for Settings > Save now (none on failure: main.ts already says the save could not be written). */
export function saveToast(outcome: SaveOutcome | void): { text: string; kind: 'good' | 'info' } | null {
  if (outcome === 'failed') return null;
  if (outcome === 'showcase') return { text: 'Showcase zoos are not saved', kind: 'info' };
  if (outcome === 'kept') return { text: 'Not saved, so your old save is kept', kind: 'info' };
  return { text: 'Zoo saved', kind: 'good' };
}

export interface ZooPanelHost {
  sim: ISimulation;
  ctx: IRenderContext;
  audio: IAudio;
  uiRoot: HTMLElement;
  /** Persist the game; older hosts return nothing (taken as saved). */
  save(): SaveOutcome | void;
  newGame(): void;
  toast(text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  qualityChanged(q: QualityLevel): void;
  /** A quality change is still being applied (creature meshes rebuild over a few seconds). */
  qualityApplying(): boolean;
  /** Recent notifications (toasts), newest first. */
  log: MessageLog;
  /** Fly the camera to a ground point (a message's location). */
  focus(x: number, z: number): void;
  /** Who plays: a profile's New zoo also replaces the zoo on the player's other devices. */
  player?: PlayerInfo | null;
  /** The menu opened or switched to a tab, and it closed (for UI extensions). */
  onShown?(tab: ZooTab): void;
  onClosed?(): void;
}

/** Settings rows an extension can hide. */
export type SettingsRowId = 'newZoo';

/** Extension sections in the order they show (by `order`, then the order they were added). */
export function orderSections<T extends Pick<SettingsSection, 'order'>>(sections: readonly T[]): T[] {
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.order - b.s.order || a.i - b.i)
    .map((x) => x.s);
}

/** The New zoo confirm text: a signed-in player's zoo is replaced on every device. */
export function newZooText(profileId: string | null | undefined): string {
  return profileId
    ? 'Your current zoo, animals and money will be replaced by a fresh start on all your devices. This cannot be undone.'
    : 'Your current zoo, animals and money will be replaced by a fresh start. This cannot be undone.';
}

/** Under Zoo stats: what makes room for more guests. */
const CAPACITY_HINT = 'Paths and new exhibits make room for more guests.';

const INCOME = '#70a24a';
const EXPENSE = '#b85a40';
/** One-offs stacked on the running bars: rewards and sales on income, building and animals on costs. */
const INCOME_ONE_OFF = '#b5d494';
const EXPENSE_ONE_OFF = '#e0b39e';

const TABS: { id: ZooTab; name: string; icon: IconName }[] = [
  { id: 'finance', name: 'Finances', icon: 'coin' },
  { id: 'goals', name: 'Goals', icon: 'trophy' },
  { id: 'stats', name: 'Zoo stats', icon: 'chart' },
  { id: 'messages', name: 'Messages', icon: 'bell' },
  { id: 'settings', name: 'Settings', icon: 'sliders' },
];

export class ZooPanel {
  readonly root: HTMLElement;
  private tabBtns = new Map<ZooTab, HTMLButtonElement>();
  private heading = el('h2');
  private closeBtn: HTMLButtonElement;
  private body = el('div', 'wh-modal-body');
  private tab: ZooTab = 'finance';
  private refreshFn: (() => void) | null = null;
  private acc = 0;
  private unread: UnreadBadge;
  /** Sections UI extensions added to Settings (shown above 'Save game'), and rows they hid. */
  private sections: SettingsSection[] = [];
  private hiddenRows = new Set<SettingsRowId>();

  constructor(private host: ZooPanelHost) {
    const tabs = el('div', 'wh-tabs');
    const title = el('div', 'wh-tabs-title');
    title.innerHTML = `${logoSvg('logo')}<span>Wildhaven</span>`;
    tabs.append(title);
    for (const t of TABS) {
      const b = button('wh-tab', t.icon, t.name, () => this.showTab(t.id));
      this.tabBtns.set(t.id, b);
      tabs.append(b);
    }
    tabs.append(el('div', 'wh-tabs-spacer'));
    this.unread = new UnreadBadge(this.tabBtns.get('messages')!, host.log, 'Messages');
    this.closeBtn = button('wh-btn-ghost wh-btn-icon', 'close', null, () => this.close(), 'Close');
    const modal = el('div', 'wh-modal wh-glass-2', [tabs, el('div', 'wh-modal-main', [el('div', 'wh-modal-head', [this.heading, this.closeBtn]), this.body])]);
    this.root = el('div', 'wh-modal-back hidden', [modal]);
    // closed: no taps, focus or key presses reach the menu's controls (see .wh-modal-back.hidden)
    this.root.inert = true;
    this.root.addEventListener('click', (ev) => {
      if (ev.target === this.root) this.close();
    });
    swallowPointer(this.root);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** The tab on screen (null while the menu is closed). */
  get currentTab(): ZooTab | null {
    return this.isOpen ? this.tab : null;
  }

  /** The menu's X button. */
  get closeEl(): HTMLElement {
    return this.closeBtn;
  }

  tabButton(t: ZooTab): HTMLElement | null {
    return this.tabBtns.get(t) ?? null;
  }

  /** Add a section to Settings, above 'Save game' (by its order). Returns a function that removes it. */
  addSettingsSection(sec: SettingsSection): () => void {
    this.sections.push(sec);
    this.rerenderSettings();
    return () => {
      const i = this.sections.indexOf(sec);
      if (i < 0) return;
      this.sections.splice(i, 1);
      this.rerenderSettings();
    };
  }

  /** Hide (or show again) a built-in Settings row, e.g. 'New zoo' in a practice zoo or a versus match. */
  hideSettingsRow(row: SettingsRowId, hidden: boolean): void {
    if (this.hiddenRows.has(row) === hidden) return;
    if (hidden) this.hiddenRows.add(row);
    else this.hiddenRows.delete(row);
    this.rerenderSettings();
  }

  /** Settings changed while on screen: draw it again where it was scrolled to (no 'shown' event: the tab did not change). */
  private rerenderSettings(): void {
    if (this.isOpen && this.tab === 'settings') {
      const top = this.body.scrollTop;
      this.renderTab('settings');
      this.body.scrollTop = top;
    }
  }

  /** The Messages tab is on screen: news shows up in its list as it comes in. */
  get readingMessages(): boolean {
    return this.isOpen && this.tab === 'messages';
  }

  /**
   * The free stretch of the title row (screen px), between the tab's name and the close
   * button: feedback toasts (e.g. Save now) show there while the menu is open; news
   * from the zoo waits until it closes.
   */
  headGap(): { x0: number; x1: number; top: number } {
    const range = document.createRange();
    range.selectNodeContents(this.heading);
    const title = range.getBoundingClientRect();
    const close = this.closeBtn.getBoundingClientRect();
    return { x0: title.right + 12, x1: close.left - 12, top: close.top };
  }

  open(tab: ZooTab = this.tab): void {
    if (!this.isOpen) cue('open');
    this.root.classList.remove('hidden');
    this.root.removeAttribute('aria-hidden');
    this.root.inert = false;
    this.showTab(tab);
  }

  close(): void {
    if (!this.isOpen) return;
    cue('close');
    this.root.classList.add('hidden');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.inert = true;
    this.refreshFn = null;
    // a focused control inside the hidden modal would keep swallowing key presses
    const a = document.activeElement as HTMLElement | null;
    if (a && this.root.contains(a)) a.blur();
    this.host.onClosed?.();
  }

  update(dt: number): void {
    if (!this.isOpen) return;
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    this.refreshFn?.();
    this.unread.update();
  }

  showTab(tab: ZooTab): void {
    this.renderTab(tab);
    this.host.onShown?.(tab);
  }

  private renderTab(tab: ZooTab): void {
    this.tab = tab;
    for (const [id, b] of this.tabBtns) toggleClass(b, 'on', id === tab);
    const t = TABS.find((x) => x.id === tab)!;
    setText(this.heading, t.name);
    this.body.textContent = '';
    this.body.scrollTop = 0;
    this.refreshFn = null;
    if (tab === 'finance') this.refreshFn = this.financeTab();
    else if (tab === 'goals') this.refreshFn = this.goalsTab();
    else if (tab === 'stats') this.refreshFn = this.statsTab();
    else if (tab === 'messages') this.refreshFn = this.messagesTab();
    else this.refreshFn = this.settingsTab();
    this.refreshFn?.();
    this.unread.update();
  }

  // ------------------------------------------------------------ finance
  private financeTab(): () => void {
    const sim = this.host.sim;
    const stat = (k: string, ic: IconName) => {
      const v = el('div', 'wh-stat-v');
      const s = el('div', 'wh-stat-s');
      const root = el('div', 'wh-stat', [el('div', { class: 'wh-stat-k', html: `${icon(ic)}${escapeHtml(k)}` }), v, s]);
      return { root, v, s };
    };
    const cash = stat('Cash', 'coin');
    const today = stat('Today’s profit', 'chart');
    const yday = stat('Yesterday', 'calendar');
    // admission slider
    const slider = el('input', { class: 'wh-slider', attrs: { type: 'range', min: '0', max: '60', step: '1', 'aria-label': 'Admission price' } }) as HTMLInputElement;
    const sval = el('div', 'wh-slider-val');
    const setSlider = (v: number) => {
      slider.value = String(v);
      slider.style.setProperty('--p', `${(v / 60) * 100}%`);
      setText(sval, fmtMoney(v));
    };
    setSlider(Math.round(sim.admissionPrice));
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      sim.setAdmission(v);
      setSlider(v);
    });
    const fair = el('div', 'wh-note wh-fair');
    let lastFair = '';
    const admission = el('div', 'wh-sect', [
      el('div', { class: 'wh-sect-h', text: 'Admission price' }),
      el('div', 'wh-slider-row', [slider, sval]),
      el('div', { class: 'wh-note', text: 'Higher prices earn more per visitor, but fewer guests come if your zoo’s rating can’t justify it.' }),
      fair,
    ]);
    const chartWrap = el('div');
    const legend = el('div', {
      class: 'wh-legend',
      html: `<span><i style="background:${INCOME}"></i>Income</span><span><i style="background:${EXPENSE}"></i>Running costs</span><span><i style="background:linear-gradient(90deg, ${INCOME_ONE_OFF} 50%, ${EXPENSE_ONE_OFF} 50%)"></i>One-off</span>`,
    });
    const tip = el('div', 'wh-chart-tip');
    const table = el('table', 'wh-ledger');
    this.body.append(
      el('div', 'wh-stat-grid', [cash.root, today.root, yday.root]),
      el('div', 'wh-two', [
        el('div', 'wh-sect', [el('div', { class: 'wh-sect-h', text: 'Last 14 days' }), legend, chartWrap, tip]),
        el('div', 'wh-sect', [el('div', { class: 'wh-sect-h', text: 'Today' }), table]),
      ]),
      admission,
    );
    let chartKey = '';
    let lastTodaySub = '';
    let lastRows = '';
    return () => {
      setText(cash.v, fmtMoney(sim.money));
      cash.v.className = `wh-stat-v ${sim.money < 0 ? 'bad' : ''}`;
      setText(cash.s, `Day ${sim.day}`);
      // running profit as midnight will book it: today's income less the whole day's running costs
      const t = sim.today;
      const c = sim.runningCosts();
      const td = { ...chartDay(t, c), day: sim.day };
      const running = td.income - td.costs;
      setText(today.v, fmtMoney(running, { sign: true }));
      today.v.className = `wh-stat-v ${running < 0 ? 'bad' : 'good'}`;
      // wrap between the two amounts, never inside one
      const sub = `<span style="white-space:nowrap">${fmtMoney(td.income)} in</span> · <span style="white-space:nowrap">${fmtMoney(td.costs)} costs</span>`;
      if (sub !== lastTodaySub) {
        lastTodaySub = sub;
        today.s.innerHTML = sub;
      }
      const y = sim.ledger[sim.ledger.length - 1];
      if (y) {
        const yd = chartDay(y);
        const yn = yd.income - yd.costs;
        setText(yday.v, fmtMoney(yn, { sign: true }));
        yday.v.className = `wh-stat-v ${yn < 0 ? 'bad' : 'good'}`;
        setText(yday.s, `${y.admissions ? fmtMoney(y.admissions) : '$0'} from tickets`);
      } else {
        setText(yday.v, '—');
        setText(yday.s, 'First day');
      }
      const rows = todayRows(t, c)
        .map((r) => {
          const v = r.value || r.total ? fmtMoney(r.value, { sign: true }) : '—';
          const cls = r.value > 0 ? 'pos' : r.value < 0 ? 'neg' : '';
          const note = r.note ? ` <span class="wh-ledger-note">${r.note}</span>` : '';
          return `<tr${r.total ? ' class="total"' : ''}><td>${r.label}${note}</td><td class="${cls}">${v}</td></tr>`;
        })
        .join('');
      if (rows !== lastRows) {
        lastRows = rows;
        table.innerHTML = rows;
      }
      const days = [...sim.ledger.slice(-13).map((d) => chartDay(d)), td];
      // drawn at its on-screen width, so its labels keep their size on any screen
      const width = Math.round(chartWrap.clientWidth) || 360;
      const key = `${width}|${days.map((d) => `${d.day}:${Math.round(d.income)}:${Math.round(d.costs)}:${Math.round(d.oneOffIn)}:${Math.round(d.invest)}`).join('|')}`;
      if (key !== chartKey) {
        chartKey = key;
        chartWrap.innerHTML = '';
        chartWrap.append(barChart(days, sim.day, tip, width));
      }
      if (document.activeElement !== slider) setSlider(Math.round(sim.admissionPrice));
      const fairPrice = sim.stats().fairAdmission;
      const price = Math.round(sim.admissionPrice);
      const verdict = price > fairPrice * 1.05 ? ' — your price is above that, so some visitors turn away' : price < fairPrice * 0.85 ? ' — you could charge more' : ' — your price is about right';
      const fairText = `Guests think about ${fmtMoney(fairPrice)} is fair${verdict}.`;
      if (fairText !== lastFair) {
        lastFair = fairText;
        setText(fair, fairText);
      }
    };
  }

  // ------------------------------------------------------------ goals
  private goalsTab(): () => void {
    const sim = this.host.sim;
    const summary = el('div', 'wh-note');
    const prog = el('div');
    const bar = el('div', 'wh-progress', [prog]);
    const list = el('div');
    const rating = el('div', 'wh-stat-grid');
    this.body.append(summary, bar, list, el('div', 'wh-sect', [el('div', { class: 'wh-sect-h', text: 'Zoo rating' }), rating]));
    let last = '';
    return () => {
      const obj = sim.objectives;
      const done = obj.filter((o) => o.done).length;
      setText(summary, `${done} of ${obj.length} goals complete`);
      prog.style.width = `${obj.length ? (done / obj.length) * 100 : 0}%`;
      // how far along each open goal is (best day so far for the one-day goals)
      const progress = new Map<string, string>();
      for (const o of obj) {
        const p = o.done ? null : sim.objectiveProgress(o.id);
        if (!p) continue;
        const best = !p.waiting && /single day|one day|for a day/.test(o.text) ? ' · best day' : '';
        // no bar before there is anything to measure, only the sim's note
        const track = p.waiting ? '' : `<span class="wh-obj-bar"><i style="width:${(goalFraction(p) * 100).toFixed(1)}%"></i></span>`;
        progress.set(o.id, `<div class="wh-obj-prog">${track}<span>${escapeHtml(goalProgressText(o, p))}${best}</span></div>`);
      }
      const key = obj.map((o) => `${o.id}:${o.done}:${progress.get(o.id) ?? ''}`).join(',');
      if (key !== last) {
        last = key;
        // open goals first, then completed
        const sorted = [...obj].sort((a, b) => Number(a.done) - Number(b.done));
        list.innerHTML = sorted
          .map(
            (o) =>
              `<div class="wh-obj ${o.done ? 'done' : ''}"><div class="wh-obj-check">${o.done ? icon('check') : ''}</div><div class="wh-obj-text">${escapeHtml(o.text)}${
                progress.get(o.id) ?? ''
              }</div><div class="wh-obj-reward">${o.reward ? fmtMoney(o.reward, { sign: true }) : ''}</div></div>`,
          )
          .join('') || '<div class="wh-note">No goals right now.</div>';
      }
      const st = sim.stats();
      rating.innerHTML = [
        statHtml('Rating', `${Math.round(sim.rating)}/100`, 'star', sim.rating >= 60 ? 'good' : sim.rating < 30 ? 'bad' : ''),
        statHtml('Animal happiness', fmtPct(st.avgAnimalHappiness), 'heart'),
        statHtml('Guest happiness', fmtPct(st.avgGuestHappiness), 'guests'),
        statHtml('Species', String(st.speciesCount), 'paw'),
      ].join('');
    };
  }

  // ------------------------------------------------------------ stats
  private statsTab(): () => void {
    const sim = this.host.sim;
    const grid = el('div', 'wh-stat-grid');
    this.body.append(grid, el('div', { class: 'wh-note', attrs: { style: 'margin-top:10px' }, text: CAPACITY_HINT }));
    return () => {
      const st = sim.stats();
      const g = guestChip(st);
      grid.innerHTML = [
        statHtml('Guests in zoo', String(st.guestsInZoo), 'guests'),
        statHtml('Capacity', String(st.guestCapacity), 'guests', g.full ? 'warn' : ''),
        statHtml('Turned away today', String(st.turnedAwayToday), 'home', st.turnedAwayToday > 0 ? 'warn' : ''),
        statHtml('Visitors today', String(st.guestsToday), 'ticket'),
        statHtml('All-time visitors', st.totalVisitors.toLocaleString('en-US'), 'chart'),
        statHtml('Animals', String(st.animalCount), 'paw'),
        statHtml('Species', String(st.speciesCount), 'leaf'),
        statHtml('Staff', String(st.staffCount), 'staff'),
        statHtml('Animal happiness', fmtPct(st.avgAnimalHappiness), 'heart', st.avgAnimalHappiness < 0.4 ? 'bad' : st.avgAnimalHappiness > 0.7 ? 'good' : ''),
        statHtml('Guest happiness', fmtPct(st.avgGuestHappiness), 'sparkle', st.avgGuestHappiness < 0.4 ? 'bad' : st.avgGuestHappiness > 0.7 ? 'good' : ''),
        statHtml('Litter', String(st.litterCount), 'trash', st.litterCount > 30 ? 'bad' : ''),
        statHtml('Habitats', String(sim.world.habitats.size), 'fence'),
        statHtml('Admission', fmtMoney(sim.admissionPrice), 'ticket'),
        // why nobody gets in (the entrance path cut, no animals on view) outranks the opening hours
        statHtml('Status', st.gateClosed ?? (sim.isOpen() ? 'Open' : 'Closed'), 'clock', st.gateClosed ? 'bad' : ''),
      ].join('');
    };
  }

  // ------------------------------------------------------------ messages
  private messagesTab(): () => void {
    const log = this.host.log;
    const list = el('div', 'wh-list');
    this.body.append(list);
    let shown = -1;
    return () => {
      log.markRead();
      if (log.version === shown) return;
      shown = log.version;
      list.textContent = '';
      if (!log.entries.length) {
        list.append(el('div', { class: 'wh-note', text: 'No messages yet. News about your animals, guests and staff will show up here.' }));
        return;
      }
      for (const m of log.entries) {
        const when = `Day ${m.day} · ${fmtClock(m.minute)}${m.count > 1 ? ` · ×${m.count}` : ''}`;
        const li = el('div', { class: `wh-li wh-msg ${m.kind}${m.focus ? ' tap' : ''}` });
        li.innerHTML = `${icon(m.kind)}<div class="wh-li-main"><div class="wh-msg-t">${escapeHtml(m.text)}</div><div class="wh-li-s">${when}</div></div>${
          m.focus ? icon('target', 'wh-msg-go') : ''
        }`;
        const at = m.focus;
        if (at)
          li.addEventListener('click', () => {
            cue('tap');
            this.close();
            this.host.focus(at.x, at.z);
          });
        list.append(li);
      }
    };
  }

  // ------------------------------------------------------------ settings
  /** 'Sound mix' expander: one slider per mixer channel, saved apart from the game (debounced). */
  private soundMix(audio: IAudio): HTMLElement {
    const prefs: AudioPrefs = parsePrefs(storageGet(AUDIO_PREFS_KEY));
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const write = () => {
      clearTimeout(saveTimer);
      storageSet(AUDIO_PREFS_KEY, serializePrefs(prefs));
    };
    // while dragging: debounced; on release: at once (a busy frame must not delay the write)
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(write, 300);
    };
    const channels: [Exclude<AudioChannel, 'music'>, string][] = [
      ['master', 'Master'],
      ['ambience', 'Ambience'],
      ['world', 'Animals & effects'],
      ['ui', 'Interface'],
    ];
    const rows = channels.map(([ch, label]) => {
      const pct = Math.round((audio.volume?.(ch) ?? prefs[ch]) * 100);
      const input = el('input', { attrs: { type: 'range', min: '0', max: '100', step: '5', value: String(pct), 'aria-label': `${label} volume` } });
      input.style.cssText = 'flex: 1; min-width: 0; height: 44px; margin: 0; accent-color: var(--wh-leaf);';
      const val = el('span', { text: `${pct}%` });
      val.style.cssText = 'width: 40px; text-align: right; font-size: 12px; color: var(--wh-muted); font-variant-numeric: tabular-nums;';
      input.addEventListener('input', () => {
        const v = Number(input.value) / 100;
        prefs[ch] = v;
        audio.setVolume?.(ch, v);
        setText(val, `${Math.round(v * 100)}%`);
        save();
      });
      input.addEventListener('change', () => {
        write();
        // releasing the Interface slider previews its new level
        if (ch === 'ui') cue('tap');
      });
      const name = el('span', { text: label });
      name.style.cssText = 'width: 38%; max-width: 150px; font-size: 13px;';
      const r = el('div', { class: 'wh-mix-row' }, [name, input, val]);
      r.style.cssText = 'display: flex; align-items: center; gap: 10px; min-height: 44px;';
      return r;
    });
    const list = el('div', { class: 'wh-mix', attrs: { id: 'wh-sound-mix' } }, rows);
    list.style.cssText = 'padding: 0 0 8px; border-bottom: 1px solid var(--wh-line);';
    list.hidden = true;
    const toggle = button('wh-btn-ghost', 'chevronDown', 'Adjust', () => {
      list.hidden = !list.hidden;
      toggle.setAttribute('aria-expanded', String(!list.hidden));
    }, 'Sound mix');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'wh-sound-mix');
    const head = el('div', 'wh-setting', [
      el('div', { class: 'wh-setting-t', html: '<b>Sound mix</b><span>Volumes for ambience, animals and the interface.</span>' }),
      toggle,
    ]);
    return el('div', '', [head, list]);
  }

  private settingsTab(): () => void {
    const ctx = this.host.ctx;
    const seg = el('div', 'wh-segtext');
    const levels: QualityLevel[] = ['low', 'medium', 'high'];
    const applying = el('span', { class: 'wh-applying hidden', attrs: { role: 'status' }, html: '<i class="wh-spin"></i>Applying graphics settings…' });
    const refresh = () => toggleClass(applying, 'hidden', !this.host.qualityApplying());
    const qBtns = levels.map((q) =>
      button(ctx.quality.level === q ? 'on' : '', null, q[0].toUpperCase() + q.slice(1), () => {
        if (ctx.quality.level === q) return;
        ctx.setQuality(q);
        storageSet(QUALITY_KEY, q);
        this.host.qualityChanged(q);
        qBtns.forEach((b, i) => toggleClass(b, 'on', levels[i] === q));
        refresh();
      }),
    );
    seg.append(...qBtns);
    const audio = this.host.audio;
    const sw = button(`wh-switch ${audio.enabled ? 'on' : ''}`, null, null, () => {
      const on = !audio.enabled;
      audio.setEnabled(on);
      if (on) audio.resume();
      toggleClass(sw, 'on', on);
      sw.setAttribute('aria-checked', String(on));
      storageSet(SOUND_KEY, on ? '1' : '0');
    }, 'Sound');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(audio.enabled));
    const row = (title: string, sub: string, ctrl: HTMLElement) =>
      el('div', 'wh-setting', [el('div', { class: 'wh-setting-t', html: `<b>${escapeHtml(title)}</b><span>${escapeHtml(sub)}</span>` }), ctrl]);
    const quality = row('Graphics quality', 'Lower settings save battery and run smoother on older phones. Edge smoothing changes after a restart.', seg);
    quality.firstElementChild!.append(applying);
    // sections added by UI extensions (tutorial, account, versus) come before 'Save game'
    const extra: HTMLElement[] = [];
    for (const sec of orderSections(this.sections)) {
      try {
        extra.push(sec.render());
      } catch (err) {
        console.error(`[ui] settings section ${sec.id} failed`, err);
      }
    }
    const rows: (HTMLElement | null)[] = [
      quality,
      row('Sound', 'Ambient sounds and effects.', sw),
      this.soundMix(audio),
      ...extra,
      row(
        'Save game',
        'Your zoo also saves automatically every few minutes.',
        button('wh-btn-ghost', 'save', 'Save now', () => {
          const t = saveToast(this.host.save());
          if (t) this.host.toast(t.text, t.kind);
        }),
      ),
      this.hiddenRows.has('newZoo')
        ? null
        : row(
            'New game',
            'Start a brand-new zoo. Your current zoo will be lost.',
            button('wh-btn-danger', 'refresh', 'New zoo', async () => {
              const ok = await showDialog(this.host.uiRoot, {
                title: 'Start a new zoo?',
                text: newZooText(this.host.player?.profileId),
                ok: 'Start over',
                danger: true,
              });
              if (ok) {
                this.close();
                this.host.newGame();
              }
            }),
          ),
      el('div', {
        class: 'wh-note',
        attrs: { style: 'margin-top:14px' },
        html:
          '<span class="wh-only-touch">Camera: drag to pan, pinch to zoom, twist with two fingers to rotate, slide two fingers up or down to tilt. Android back closes panels.</span>' +
          '<span class="wh-only-mouse">Camera: drag to pan, right-drag to rotate, wheel to zoom, WASD / QE to move and turn. Esc closes panels, R rotates, Space pauses.</span>',
      }),
    ];
    for (const r of rows) if (r) this.body.append(r);
    return refresh;
  }

  dispose(): void {
    this.root.remove();
  }
}

function statHtml(k: string, v: string, ic: IconName, cls = ''): string {
  return `<div class="wh-stat"><div class="wh-stat-k">${icon(ic)}${escapeHtml(k)}</div><div class="wh-stat-v ${cls}">${escapeHtml(v)}</div></div>`;
}

/** A day's money split as the day-close message splits it: running income and costs, and one-offs. */
export interface ChartDay {
  day: number;
  /** Tickets, shops and donations. */
  income: number;
  /** Wages, animal food and upkeep. */
  costs: number;
  /** Goal rewards, animal sales and removal refunds. */
  oneOffIn: number;
  /** Building and animal purchases. */
  invest: number;
}

/**
 * Split a ledger day. Today's running costs are booked at midnight, so `estimate` (the sim's
 * whole-day figure) stands in for them.
 */
export function chartDay(d: LedgerEntry, estimate?: RunningCostEstimate): ChartDay {
  return {
    day: d.day,
    income: d.admissions + d.shopIncome + d.donations,
    costs: estimate ? estimate.day.total : d.salaries + (d.food ?? 0) + d.upkeep,
    oneOffIn: d.other,
    invest: d.construction + d.animalPurchases,
  };
}

/** One row of the Today table; `total` rows sum up what is above them. */
export interface FinanceRow {
  label: string;
  value: number;
  /** E.g. "at midnight": a running cost still to be booked. */
  note?: string;
  total?: boolean;
}

/**
 * Today's ledger with the running costs midnight will book (so the profit doesn't climb all
 * day and drop at midnight), then the one-offs that the day-close message keeps apart.
 */
export function todayRows(t: LedgerEntry, c: RunningCostEstimate): FinanceRow[] {
  const d = chartDay(t, c);
  const running = d.income - d.costs;
  // part of it may be booked already (staff dismissed today are paid on the spot)
  const due = (whole: number, booked: number) => (whole - booked > 0.5 ? 'due at midnight' : undefined);
  const rows: FinanceRow[] = [
    { label: 'Tickets', value: t.admissions },
    { label: 'Shops', value: t.shopIncome },
    { label: 'Donations', value: t.donations },
    { label: 'Wages', value: -c.day.wages, note: due(c.day.wages, t.salaries) },
    { label: 'Animal food', value: -c.day.food, note: due(c.day.food, t.food ?? 0) },
    { label: 'Upkeep', value: -c.day.upkeep, note: due(c.day.upkeep, t.upkeep) },
    { label: 'Running profit', value: running, total: true },
  ];
  // one-offs only when there are any (then the net of everything closes the table)
  const oneOffs: FinanceRow[] = [
    { label: 'Rewards & refunds', value: d.oneOffIn },
    { label: 'Construction', value: -t.construction },
    { label: 'Animals', value: -t.animalPurchases },
  ].filter((r) => Math.round(r.value) !== 0);
  if (!oneOffs.length) return rows;
  return [...rows, ...oneOffs, { label: 'Net', value: running + d.oneOffIn - d.invest, total: true }];
}

/** Top of the chart's scale: running income and costs only, so one big building day doesn't flatten the rest. */
export function chartTop(days: readonly ChartDay[]): number {
  return niceMax(Math.max(100, ...days.map((d) => Math.max(d.income, d.costs))));
}

/**
 * Grouped bars for recent days: income (with one-off rewards stacked on top) and running costs
 * (with building stacked on top). Today's running bars are striped as partial; bars past the
 * scale are cut at the top with a break mark.
 */
function barChart(days: ChartDay[], today: number, tip: HTMLElement, W: number): SVGSVGElement {
  const H = 150,
    padB = 18,
    padT = 8;
  const nice = chartTop(days);
  // room for the widest axis label ("$2.5M", "$250k" …) at 10.5 px
  const padL = 12 + Math.max(shortMoney(nice).length, shortMoney(nice / 2).length) * 6.5;
  const plotW = W - padL - 4,
    plotH = H - padB - padT;
  const n = Math.max(days.length, 7);
  const slot = plotW / n;
  const bw = Math.max(3, Math.min(10, slot * 0.34));
  const base = padT + plotH;
  const y = (v: number) => base - (Math.min(v, nice) / nice) * plotH;
  const parts: string[] = [];
  parts.push(
    `<defs><pattern id="wh-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${INCOME}"/><rect width="2" height="5" fill="rgba(0,0,0,.28)"/></pattern><pattern id="wh-hatch2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${EXPENSE}"/><rect width="2" height="5" fill="rgba(0,0,0,.28)"/></pattern></defs>`,
  );
  for (let g = 0; g <= 2; g++) {
    const v = (nice / 2) * g;
    const gy = y(v);
    parts.push(`<line x1="${padL}" x2="${W - 2}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,${g === 0 ? 0.18 : 0.07})" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${shortMoney(v)}</text>`);
  }
  /** A bar of `run` with `extra` stacked on it; the data end is rounded, the baseline square. */
  const bar = (x: number, run: number, extra: number, fill: string, extraFill: string) => {
    const mid = y(run);
    const top = y(run + extra);
    if (base - top < 0.5) return '';
    const r = Math.min(3, bw / 2, base - top);
    const out: string[] = [];
    // the one-off part first, rounded at its top; the running part over its square bottom edge
    if (mid - top >= 0.5)
      out.push(`<path d="M${x.toFixed(1)} ${mid.toFixed(1)}V${(top + r).toFixed(1)}q0 ${-r} ${r} ${-r}h${(bw - 2 * r).toFixed(1)}q${r} 0 ${r} ${r}V${mid.toFixed(1)}z" fill="${extraFill}"/>`);
    if (base - mid >= 0.5) {
      const rr = mid - top >= 0.5 ? 0 : r;
      out.push(`<path d="M${x.toFixed(1)} ${base.toFixed(1)}V${(mid + rr).toFixed(1)}q0 ${-rr} ${rr} ${-rr}h${(bw - 2 * rr).toFixed(1)}q${rr} 0 ${rr} ${rr}V${base.toFixed(1)}z" fill="${fill}"/>`);
    }
    // off the scale: a gap near the top says the bar goes on
    if (run + extra > nice) out.push(`<rect x="${(x - 1).toFixed(1)}" y="${(padT + 5).toFixed(1)}" width="${(bw + 2).toFixed(1)}" height="2.5" fill="#141a16"/>`);
    return out.join('');
  };
  days.forEach((d, i) => {
    const cx = padL + slot * (i + 0.5) + (n - days.length) * slot;
    const isToday = d.day === today;
    parts.push(bar(cx - bw - 1, d.income, d.oneOffIn, isToday ? 'url(#wh-hatch)' : INCOME, INCOME_ONE_OFF));
    parts.push(bar(cx + 1, d.costs, d.invest, isToday ? 'url(#wh-hatch2)' : EXPENSE, EXPENSE_ONE_OFF));
    if (i === days.length - 1 || i % 2 === (days.length - 1) % 2)
      parts.push(`<text x="${cx.toFixed(1)}" y="${H - 4}" text-anchor="middle">${isToday ? 'Today' : d.day}</text>`);
    // generous hit target per day
    parts.push(
      `<rect class="hit" data-i="${i}" x="${(cx - slot / 2).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"/>`,
    );
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'wh-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Income and costs for recent days');
  svg.innerHTML = parts.join('');
  const show = (i: number) => {
    const d = days[i];
    if (!d) return;
    const oneOffs = [d.oneOffIn ? `rewards ${fmtMoney(d.oneOffIn, { sign: true })}` : '', d.invest ? `building ${fmtMoney(-d.invest, { sign: true })}` : ''].filter(Boolean);
    tip.textContent = `${d.day === today ? 'Today' : `Day ${d.day}`}: ${fmtMoney(d.income)} in · ${fmtMoney(d.costs)} running costs${oneOffs.length ? ` · ${oneOffs.join(' · ')}` : ''}`;
  };
  svg.addEventListener('pointerover', (e) => {
    const t = e.target as Element;
    if (t.classList.contains('hit')) show(Number(t.getAttribute('data-i')));
  });
  svg.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.classList.contains('hit')) show(Number(t.getAttribute('data-i')));
  });
  show(days.length - 1);
  return svg;
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function shortMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k`;
  return `$${Math.round(v)}`;
}
