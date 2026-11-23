// Zoo menu: finances (ledger, daily chart, admission price), goals, statistics,
// recent messages and settings (graphics quality, sound, save, new game).
// Refreshes at ~2 Hz while open.

import { QUALITY_KEY, SOUND_KEY } from '../core/constants';
import type { IAudio, IRenderContext, ISimulation, QualityLevel } from '../core/contracts';
import type { LedgerEntry } from '../core/types';
import { button, el, escapeHtml, fmtClock, fmtMoney, fmtPct, setText, storageSet, swallowPointer, toggleClass } from './dom';
import { icon, type IconName } from './icons';
import type { MessageLog } from './notify';
import { logoSvg } from './screens';
import { showDialog } from './panels';
import { cue } from './sound';

export type ZooTab = 'finance' | 'goals' | 'stats' | 'messages' | 'settings';

export interface ZooPanelHost {
  sim: ISimulation;
  ctx: IRenderContext;
  audio: IAudio;
  uiRoot: HTMLElement;
  save(): void;
  newGame(): void;
  toast(text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  qualityChanged(q: QualityLevel): void;
  /** Recent notifications (toasts), newest first. */
  log: MessageLog;
  /** Fly the camera to a ground point (a message's location). */
  focus(x: number, z: number): void;
}

const INCOME = '#70a24a';
const EXPENSE = '#b85a40';

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
  private body = el('div', 'wh-modal-body');
  private tab: ZooTab = 'finance';
  private refreshFn: (() => void) | null = null;
  private acc = 0;

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
    const modal = el('div', 'wh-modal wh-glass-2', [
      tabs,
      el('div', 'wh-modal-main', [el('div', 'wh-modal-head', [this.heading, button('wh-btn-ghost wh-btn-icon', 'close', null, () => this.close(), 'Close')]), this.body]),
    ]);
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
  }

  update(dt: number): void {
    if (!this.isOpen || !this.refreshFn) return;
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    this.refreshFn();
  }

  showTab(tab: ZooTab): void {
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
    else this.settingsTab();
    this.refreshFn?.();
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
      html: `<span><i style="background:${INCOME}"></i>Income</span><span><i style="background:${EXPENSE}"></i>Expenses</span><span style="margin-left:auto" class="wh-chart-tip"></span>`,
    });
    const tip = legend.querySelector('.wh-chart-tip') as HTMLElement;
    const table = el('table', 'wh-ledger');
    this.body.append(
      el('div', 'wh-stat-grid', [cash.root, today.root, yday.root]),
      el('div', 'wh-two', [
        el('div', 'wh-sect', [el('div', { class: 'wh-sect-h', text: 'Last 14 days' }), legend, chartWrap]),
        el('div', 'wh-sect', [el('div', { class: 'wh-sect-h', text: 'Today' }), table]),
      ]),
      admission,
    );
    let chartKey = '';
    let lastTodaySub = '';
    return () => {
      setText(cash.v, fmtMoney(sim.money));
      cash.v.className = `wh-stat-v ${sim.money < 0 ? 'bad' : ''}`;
      setText(cash.s, `Day ${sim.day}`);
      const t = sim.today;
      const net = t.income - t.expenses;
      setText(today.v, fmtMoney(net, { sign: true }));
      today.v.className = `wh-stat-v ${net < 0 ? 'bad' : 'good'}`;
      // wrap between the two amounts, never inside one
      const sub = `<span style="white-space:nowrap">${fmtMoney(t.income)} in</span> · <span style="white-space:nowrap">${fmtMoney(t.expenses)} out</span>`;
      if (sub !== lastTodaySub) {
        lastTodaySub = sub;
        today.s.innerHTML = sub;
      }
      const y = sim.ledger[sim.ledger.length - 1];
      if (y) {
        const yn = y.income - y.expenses;
        setText(yday.v, fmtMoney(yn, { sign: true }));
        yday.v.className = `wh-stat-v ${yn < 0 ? 'bad' : 'good'}`;
        setText(yday.s, `${y.admissions ? fmtMoney(y.admissions) : '$0'} from tickets`);
      } else {
        setText(yday.v, '—');
        setText(yday.s, 'First day');
      }
      // goal rewards, animal sales and removal refunds are booked as income without a category of their own
      const other = t.income - t.admissions - t.shopIncome - t.donations;
      const rows: [string, number][] = [
        ['Tickets', t.admissions],
        ['Shops', t.shopIncome],
        ['Donations', t.donations],
        ['Rewards & refunds', Math.abs(other) < 0.5 ? 0 : other],
        ['Construction', -t.construction],
        ['Animals', -t.animalPurchases],
        ['Wages', -t.salaries],
        ['Animal food', -(t.food ?? 0)],
        ['Upkeep', -t.upkeep],
      ];
      table.innerHTML =
        rows
          .map(([k, v]) => `<tr><td>${k}</td><td class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v ? fmtMoney(v, { sign: true }) : '—'}</td></tr>`)
          .join('') + `<tr class="total"><td>Net</td><td class="${net >= 0 ? 'pos' : 'neg'}">${fmtMoney(net, { sign: true })}</td></tr>`;
      const days = [...sim.ledger.slice(-13), { ...t, day: sim.day }];
      const key = days.map((d) => `${d.day}:${Math.round(d.income)}:${Math.round(d.expenses)}`).join('|');
      if (key !== chartKey) {
        chartKey = key;
        chartWrap.innerHTML = '';
        chartWrap.append(barChart(days, sim.day, tip));
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
      const key = obj.map((o) => `${o.id}:${o.done}`).join(',');
      if (key !== last) {
        last = key;
        // open goals first, then completed
        const sorted = [...obj].sort((a, b) => Number(a.done) - Number(b.done));
        list.innerHTML = sorted
          .map(
            (o) =>
              `<div class="wh-obj ${o.done ? 'done' : ''}"><div class="wh-obj-check">${o.done ? icon('check') : ''}</div><div class="wh-obj-text">${escapeHtml(o.text)}</div><div class="wh-obj-reward">${
                o.reward ? fmtMoney(o.reward, { sign: true }) : ''
              }</div></div>`,
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
    this.body.append(grid);
    return () => {
      const st = sim.stats();
      grid.innerHTML = [
        statHtml('Guests in zoo', String(st.guestsInZoo), 'guests'),
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
        statHtml('Status', sim.isOpen() ? 'Open' : 'Closed', 'clock'),
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
  private settingsTab(): void {
    const ctx = this.host.ctx;
    const seg = el('div', 'wh-segtext');
    const levels: QualityLevel[] = ['low', 'medium', 'high'];
    const qBtns = levels.map((q) =>
      button(ctx.quality.level === q ? 'on' : '', null, q[0].toUpperCase() + q.slice(1), () => {
        if (ctx.quality.level === q) return;
        ctx.setQuality(q);
        storageSet(QUALITY_KEY, q);
        this.host.qualityChanged(q);
        qBtns.forEach((b, i) => toggleClass(b, 'on', levels[i] === q));
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
    this.body.append(
      row('Graphics quality', 'Lower settings save battery and run smoother on older phones. Edge smoothing changes after a restart.', seg),
      row('Sound', 'Ambient sounds and effects.', sw),
      row(
        'Save game',
        'Your zoo also saves automatically every few minutes.',
        button('wh-btn-ghost', 'save', 'Save now', () => {
          this.host.save();
          this.host.toast('Zoo saved', 'good');
        }),
      ),
      row(
        'New game',
        'Start a brand-new zoo. Your current zoo will be lost.',
        button('wh-btn-danger', 'refresh', 'New zoo', async () => {
          const ok = await showDialog(this.host.uiRoot, {
            title: 'Start a new zoo?',
            text: 'Your current zoo, animals and money will be replaced by a fresh start. This cannot be undone.',
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
    );
  }

  dispose(): void {
    this.root.remove();
  }
}

function statHtml(k: string, v: string, ic: IconName, cls = ''): string {
  return `<div class="wh-stat"><div class="wh-stat-k">${icon(ic)}${escapeHtml(k)}</div><div class="wh-stat-v ${cls}">${escapeHtml(v)}</div></div>`;
}

/** Grouped income/expense bars for recent days (today striped as partial). */
function barChart(days: LedgerEntry[], today: number, tip: HTMLElement): SVGSVGElement {
  const W = 360,
    H = 150,
    padB = 18,
    padT = 8;
  const max = Math.max(100, ...days.map((d) => Math.max(d.income, d.expenses)));
  const nice = niceMax(max);
  // room for the widest axis label ("$2.5M", "$250k" …) at 10 px
  const padL = 12 + Math.max(shortMoney(nice).length, shortMoney(nice / 2).length) * 6;
  const plotW = W - padL - 4,
    plotH = H - padB - padT;
  const n = Math.max(days.length, 7);
  const slot = plotW / n;
  const bw = Math.max(3, Math.min(10, slot * 0.34));
  const y = (v: number) => padT + plotH - (v / nice) * plotH;
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
  const bar = (x: number, v: number, fill: string) => {
    const top = y(v);
    const h = Math.max(0, padT + plotH - top);
    if (h < 0.5) return '';
    const r = Math.min(3, bw / 2, h);
    // rounded data-end, square baseline
    return `<path d="M${x.toFixed(1)} ${(padT + plotH).toFixed(1)}V${(top + r).toFixed(1)}q0 ${-r} ${r} ${-r}h${(bw - 2 * r).toFixed(1)}q${r} 0 ${r} ${r}V${(padT + plotH).toFixed(1)}z" fill="${fill}"/>`;
  };
  days.forEach((d, i) => {
    const cx = padL + slot * (i + 0.5) + (n - days.length) * slot;
    const isToday = d.day === today;
    parts.push(bar(cx - bw - 1, d.income, isToday ? 'url(#wh-hatch)' : INCOME));
    parts.push(bar(cx + 1, d.expenses, isToday ? 'url(#wh-hatch2)' : EXPENSE));
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
  svg.setAttribute('aria-label', 'Income and expenses for recent days');
  svg.innerHTML = parts.join('');
  const show = (i: number) => {
    const d = days[i];
    if (!d) return;
    tip.textContent = `${d.day === today ? 'Today' : `Day ${d.day}`}: ${fmtMoney(d.income)} in · ${fmtMoney(d.expenses)} out`;
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
