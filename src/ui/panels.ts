// Info panels for the selected thing (animal, guest, staff, object, habitat),
// the species card shown while adopting, and a small confirm dialog.
// Panels are built once per selection and refreshed at ~2 Hz.

import type { HabitatReport, ISimulation, SpeciesSuitability } from '../core/contracts';
import { TILE } from '../core/constants';
import { TERRAIN_COUNT, type AnimalAction, type GuestAction, type Habitat, type SelectionRef, type SpeciesDef, type StaffDayStats, type StaffRole, type Terrain } from '../core/types';
import { BLOCKED_VIEW, FENCES_BY_ID, fenceAdvice } from '../data/fences';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import { BIOME_NAME, STAFF_INFO, TERRAIN_INFO, type ThumbSpec } from './catalog';
import { button, el, escapeHtml, fmtMoney, fmtPct, iconEl, levelClass, meter, setText, swallowPointer } from './dom';
import { icon, type IconName } from './icons';
import { cue } from './sound';
import type { ThumbnailService } from './thumbs';

// ---------------------------------------------------------------------------
// labels

const ANIMAL_ACTION: Record<AnimalAction, string> = {
  idle: 'Resting',
  walk: 'Wandering',
  run: 'Running',
  eat: 'Eating',
  drink: 'Drinking',
  sleep: 'Sleeping',
  sit: 'Lying down',
  play: 'Playing',
  swim: 'Swimming',
  social: 'Socialising',
  call: 'Calling out',
};

const GUEST_ACTION: Record<GuestAction, string> = {
  walk: 'Strolling',
  idle: 'Looking around',
  watch: 'Watching animals',
  eat: 'Eating',
  drink: 'Having a drink',
  sit: 'Taking a rest',
  shop: 'Shopping',
  restroom: 'In the restroom',
  leave: 'Heading home',
};

const HOLDING: Record<string, string> = { none: 'Nothing', food: 'Snack', drink: 'Drink', icecream: 'Ice cream', balloon: 'Balloon', gift: 'Souvenir' };

const CATEGORY_NAME: Record<string, string> = {
  tree: 'Tree',
  plant: 'Plant',
  rock: 'Rock & log',
  shelter: 'Animal shelter',
  enrichment: 'Enrichment',
  feeder: 'Feeder',
  shop: 'Shop',
  facility: 'Guest facility',
  amenity: 'Amenity',
  decoration: 'Decoration',
};

/**
 * 'sit' as each species' rig draws it (src/models/species): the lion has a cat sit and the
 * primate, penguin and bird rigs sit; tigers and bears rest sitting up or lying down; the other
 * quadrupeds alias sit to lying down.
 */
const SITS_UP = new Set(['lion']);
const SITS_OR_LIES = new Set(['tiger', 'grizzly', 'polarbear']);

export function animalActionLabel(action: AnimalAction, sp: Pick<SpeciesDef, 'id' | 'rig'> | undefined): string {
  if (action !== 'sit' || !sp) return ANIMAL_ACTION[action] ?? action;
  if (sp.rig !== 'quadruped' || SITS_UP.has(sp.id)) return 'Sitting';
  return SITS_OR_LIES.has(sp.id) ? 'Resting' : ANIMAL_ACTION.sit;
}

/** Short fence names for the habitat panel ("Stone / Glass"). */
const FENCE_SHORT: Record<string, string> = { wood: 'Timber', chainlink: 'Chain-link', stone: 'Stone', glass: 'Glass', steel: 'Steel' };

export function weakestFenceText(h: Pick<Habitat, 'minFenceStrength' | 'weakestFenceIds'>): string {
  const names = h.weakestFenceIds.map((id) => FENCES_BY_ID[id]).filter(Boolean).map((f) => FENCE_SHORT[f.key] ?? f.name);
  return `${h.minFenceStrength}/4${names.length ? ` · ${names.join(' / ')}` : ''}`;
}

/** Guest view of a habitat from its viewing paths: text and how it reads (good / warn). */
export function guestViewText(viewable: boolean, quality: number): { text: string; kind: 'good' | 'warn' } {
  if (!viewable) return { text: 'No path nearby', kind: 'warn' };
  if (quality < BLOCKED_VIEW) return { text: 'Poor — walls block the view', kind: 'warn' };
  return quality < 0.75 ? { text: 'Partial', kind: 'good' } : { text: 'Good', kind: 'good' };
}

/** Below this share of the room its animals need, crowding stresses them and makes them sick (as the sim's CROWDED_SPACE). */
const STRESS_SPACE = 0.7;

/** Habitat room from the lowest Space of its species (1 = room for everyone): text and how it reads. */
export function roomText(space: number, area: number): { text: string; kind: 'good' | 'warn' | 'bad' } {
  if (space >= 0.95) return { text: 'Enough room', kind: 'good' };
  // space = area / tiles needed (the sim's ceil of a fractional need; the epsilon absorbs float noise)
  const needs = Math.ceil(area / Math.max(0.01, space) - 1e-6);
  return space < STRESS_SPACE
    ? { text: `Too crowded — needs ${needs} tiles`, kind: 'bad' }
    : { text: `A bit crowded — needs ${needs} tiles`, kind: 'warn' };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A staff member's work today, in their role's terms. */
export function staffWorkText(role: StaffRole, w: StaffDayStats): string {
  if (role === 'keeper') return `${plural(w.serviced, 'habitat')} fed · ${plural(w.cleaned, 'dung pile')} cleared`;
  if (role === 'vet') return `${plural(w.treated, 'animal')} treated · ${w.recaptured} brought back`;
  return `${plural(w.cleaned, 'piece')} of litter picked up`;
}

// ---------------------------------------------------------------------------
// dialog

const openDialogs: ((v: boolean) => void)[] = [];

/** Close the top-most confirm dialog (Android back). Returns false if none is open. */
export function closeTopDialog(): boolean {
  const fin = openDialogs[openDialogs.length - 1];
  if (!fin) return false;
  fin(false);
  return true;
}

export function dialogOpen(): boolean {
  return openDialogs.length > 0;
}

export function showDialog(
  root: HTMLElement,
  opts: { title: string; text: string; ok: string; cancel?: string; danger?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    const back = el('div', { class: 'wh-dialog-back', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title } });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      const i = openDialogs.indexOf(finish);
      if (i >= 0) openDialogs.splice(i, 1);
      if (!v) cue('close');
      back.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== finish) return;
      if (e.code === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        finish(false);
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.stopPropagation();
        e.preventDefault();
        finish(true);
      }
    };
    const okBtn = button(opts.danger ? 'wh-btn-danger' : 'wh-btn-primary', null, opts.ok, () => finish(true));
    const box = el('div', 'wh-dialog wh-glass-2', [
      el('h3', { text: opts.title }),
      el('p', { text: opts.text }),
      el('div', 'wh-dialog-btns', [button('wh-btn-ghost', null, opts.cancel ?? 'Cancel', () => finish(false)), okBtn]),
    ]);
    back.append(box);
    back.addEventListener('click', (ev) => {
      if (ev.target === back) finish(false);
    });
    swallowPointer(back);
    window.addEventListener('keydown', onKey, true);
    openDialogs.push(finish);
    root.append(back);
    cue('open');
    okBtn.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------------------
// sheet chrome

export class Sheet {
  readonly root: HTMLElement;
  private badge = el('div', 'wh-sheet-badge');
  private title = el('div', 'wh-sheet-title');
  private sub = el('div', 'wh-sheet-sub');
  readonly body = el('div', 'wh-sheet-body');
  private foot = el('div', 'wh-sheet-foot');
  private badgeToken = 0;

  constructor(cls: string, onClose: () => void) {
    this.root = el('div', `wh-sheet wh-glass-2 hidden ${cls}`, [
      el('div', 'wh-sheet-head', [this.badge, el('div', 'wh-sheet-titles', [this.title, this.sub]), button('wh-btn-ghost wh-btn-icon', 'close', null, onClose, 'Close')]),
      this.body,
      this.foot,
    ]);
    swallowPointer(this.root);
  }

  get open(): boolean {
    return !this.root.classList.contains('hidden');
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  setBadge(thumbs: ThumbnailService, spec: ThumbSpec | null, ico: IconName): void {
    this.badge.textContent = '';
    this.badge.append(iconEl(ico));
    const token = ++this.badgeToken;
    if (!spec) return;
    const target = this.badge;
    const apply = (url: string) => {
      if (token !== this.badgeToken) return; // a newer selection replaced this badge
      target.textContent = '';
      const img = el('img', { attrs: { alt: '', draggable: 'false' } });
      img.src = url;
      target.append(img);
    };
    const hit = thumbs.get(spec);
    if (hit) apply(hit);
    else thumbs.request(spec, apply, true);
  }

  titleEl(): HTMLElement {
    return this.title;
  }

  setTitle(t: string, sub: string, subHtml = false): void {
    setText(this.title, t);
    if (subHtml) {
      if (this.sub.innerHTML !== sub) this.sub.innerHTML = sub;
    } else setText(this.sub, sub);
  }

  setSub(sub: string): void {
    setText(this.sub, sub);
  }

  setFoot(btns: HTMLElement[]): void {
    this.foot.textContent = '';
    for (const b of btns) this.foot.append(b);
    this.foot.style.display = btns.length ? '' : 'none';
  }

  reset(): void {
    this.body.textContent = '';
    this.body.scrollTop = 0;
    this.setFoot([]);
    this.title.className = 'wh-sheet-title';
    this.title.onclick = null;
  }
}

// ---------------------------------------------------------------------------
// shared bits

function sect(title: string, ...children: (Node | null)[]): HTMLElement {
  return el('div', 'wh-sect', [el('div', { class: 'wh-sect-h', text: title }), ...children]);
}

function kvItem(k: string): { root: HTMLElement; v: HTMLElement } {
  const v = el('div', 'wh-kv-v');
  return { root: el('div', 'wh-kv-item', [el('div', { class: 'wh-kv-k', text: k }), v]), v };
}

function compositionBar(fr: number[]): { bar: HTMLElement; legend: HTMLElement; set(fr: number[]): void } {
  const bar = el('div', 'wh-comp');
  const legend = el('div', 'wh-tags');
  const segs: HTMLElement[] = [];
  for (let t = 0; t < TERRAIN_COUNT; t++) {
    const s = el('span');
    s.style.background = TERRAIN_INFO[t].color;
    s.style.width = '0%';
    s.title = TERRAIN_INFO[t].name;
    segs.push(s);
    bar.append(s);
  }
  let lastKey = '';
  const set = (f: number[]) => {
    for (let t = 0; t < TERRAIN_COUNT; t++) {
      const w = `${((f[t] ?? 0) * 100).toFixed(1)}%`;
      if (segs[t].style.width !== w) segs[t].style.width = w;
    }
    const top = f
      .map((v, t) => ({ v, t }))
      .filter((x) => x.v >= 0.02)
      .sort((a, b) => b.v - a.v)
      .slice(0, 5);
    const key = top.map((x) => `${x.t}:${Math.round(x.v * 100)}`).join(',');
    if (key === lastKey) return;
    lastKey = key;
    legend.innerHTML = top
      .map((x) => `<span class="wh-tag"><i style="background:${TERRAIN_INFO[x.t].color}"></i>${TERRAIN_INFO[x.t].name} ${Math.round(x.v * 100)}%</span>`)
      .join('');
  };
  set(fr);
  return { bar, legend, set };
}

/** Suitability block: score + three meters + facility tags + issues. */
function suitabilityBlock(name: string): { root: HTMLElement; set(s: SpeciesSuitability): void } {
  const score = el('span', 'wh-score');
  const mT = meter('Terrain', 'layers');
  const mF = meter('Foliage', 'tree');
  const mS = meter('Space', 'ruler');
  const tags = el('div', 'wh-tags');
  const issues = el('ul', 'wh-issues');
  const root = el('div', 'wh-suit', [
    el('div', 'wh-suit-head', [el('span', { class: 'wh-suit-name', text: name }), score]),
    el('div', 'wh-meters', [mT.root, mF.root, mS.root]),
    el('div', { class: 'wh-tags', attrs: { style: 'margin-top:9px' } }, [tags]),
    issues,
  ]);
  let lastIssues = '';
  let lastTags = '';
  return {
    root,
    set(s: SpeciesSuitability) {
      setText(score, fmtPct(s.score));
      score.className = `wh-score ${levelClass(s.score)}`;
      mT.set(s.terrain);
      mF.set(s.foliage);
      mS.set(s.space);
      const tg = [
        s.fenceOk ? '<span class="wh-tag good">Fence strong enough</span>' : '<span class="wh-tag bad">Fence too weak</span>',
        s.hasWater ? '<span class="wh-tag good">Water</span>' : '<span class="wh-tag warn">No water</span>',
        s.hasFood ? '<span class="wh-tag good">Food</span>' : '<span class="wh-tag warn">No feeder</span>',
      ].join('');
      if (tg !== lastTags) {
        lastTags = tg;
        tags.innerHTML = tg;
      }
      const iss = s.issues.length ? s.issues.slice(0, 5).map((i) => `<li>${escapeHtml(i)}</li>`).join('') : '<li class="ok">Everything this species needs is here.</li>';
      if (iss !== lastIssues) {
        lastIssues = iss;
        issues.innerHTML = iss;
      }
    },
  };
}

function ageText(days: number, growth: number): string {
  const d = Math.floor(days);
  const stage = growth >= 0.999 ? 'Adult' : growth > 0.6 ? 'Juvenile' : 'Baby';
  return `${stage} · ${d} day${d === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// panel host + controller

export interface PanelHost {
  sim: ISimulation;
  thumbs: ThumbnailService;
  uiRoot: HTMLElement;
  select(sel: SelectionRef | null): void;
  focusOn(x: number, z: number, distance?: number): void;
  toggleFollow(sel: SelectionRef): void;
  isFollowing(sel: SelectionRef): boolean;
  openAnimals(): void;
  /** Pick the animal / object up and place it elsewhere with the build tool. */
  startMove(sel: SelectionRef): void;
}

interface PanelView {
  /** Update values; return false if the subject no longer exists. */
  refresh(): boolean;
}

export class InfoPanel {
  readonly sheet: Sheet;
  private sel: SelectionRef | null = null;
  private view: PanelView | null = null;
  private acc = 0;
  private followBtn: HTMLButtonElement | null = null;

  constructor(private host: PanelHost) {
    this.sheet = new Sheet('', () => host.select(null));
  }

  get current(): SelectionRef | null {
    return this.sel;
  }

  show(sel: SelectionRef | null): void {
    this.sel = sel;
    this.view = null;
    this.followBtn = null;
    if (!sel) {
      if (this.sheet.open) cue('close');
      this.sheet.hide();
      return;
    }
    this.sheet.reset();
    switch (sel.kind) {
      case 'animal':
        this.view = this.animalView(sel.id);
        break;
      case 'guest':
        this.view = this.guestView(sel.id);
        break;
      case 'staff':
        this.view = this.staffView(sel.id);
        break;
      case 'object':
        this.view = this.objectView(sel.id);
        break;
      case 'habitat':
        this.view = this.habitatView(sel.id);
        break;
    }
    if (!this.view || !this.view.refresh()) {
      this.sel = null;
      this.sheet.hide();
      return;
    }
    this.sheet.show();
    this.acc = 0;
  }

  update(dt: number): void {
    if (!this.view || !this.sel) return;
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    if (!this.view.refresh()) this.host.select(null);
  }

  /** Follow state changed externally (user panned away). */
  syncFollow(): void {
    if (this.followBtn && this.sel) this.setFollowBtn(this.host.isFollowing(this.sel));
  }

  private setFollowBtn(on: boolean): void {
    const b = this.followBtn;
    if (!b) return;
    b.className = `wh-btn ${on ? 'wh-btn-primary' : 'wh-btn-ghost'}`;
    b.innerHTML = `${icon('target')}<span class="wh-btn-label">${on ? 'Following' : 'Follow'}</span>`;
  }

  private makeFollow(sel: SelectionRef): HTMLButtonElement {
    const b = button('wh-btn-ghost', 'target', 'Follow', () => {
      this.host.toggleFollow(sel);
      this.setFollowBtn(this.host.isFollowing(sel));
    });
    this.followBtn = b;
    this.setFollowBtn(this.host.isFollowing(sel));
    return b;
  }

  // ------------------------------------------------------------ animal
  private animalView(id: number): PanelView | null {
    const sim = this.host.sim;
    const a0 = sim.animals.get(id);
    if (!a0) return null;
    const sp = SPECIES_BY_ID[a0.speciesId];
    const s = this.sheet;
    s.setBadge(this.host.thumbs, { kind: 'animal', speciesId: a0.speciesId }, 'paw');
    const happy = meter('Happiness', 'heart');
    const health = meter('Health', 'health');
    happy.root.classList.add('big');
    health.root.classList.add('big');
    const needs = [
      ['Food', 'hunger', 'bowl'],
      ['Water', 'thirst', 'drop'],
      ['Energy', 'energy', 'sun'],
      ['Company', 'social', 'paw'],
      ['Habitat', 'environment', 'tree'],
      ['Space', 'space', 'ruler'],
      ['Enrichment', 'enrichment', 'sparkle'],
    ] as const;
    const needMeters = needs.map(([label, , ic]) => meter(label, ic));
    const kvAct = kvItem('Doing');
    const kvAge = kvItem('Age');
    const kvHab = kvItem('Habitat');
    const kvSex = kvItem('Sex');
    kvHab.root.classList.add('tap');
    kvHab.root.style.cursor = 'pointer';
    kvHab.root.addEventListener('click', () => {
      const a = sim.animals.get(id);
      if (a?.habitatId) this.host.select({ kind: 'habitat', id: a.habitatId });
    });
    const alert = el('div', { class: 'wh-tags', attrs: { style: 'margin-top:8px' } });
    s.body.append(
      el('div', 'wh-meters', [happy.root, health.root]),
      alert,
      sect('Needs', el('div', 'wh-meters', needMeters.map((m) => m.root))),
      sect('Details', el('div', 'wh-kv', [kvAct.root, kvAge.root, kvHab.root, kvSex.root])),
    );
    if (sp) s.body.append(el('p', { class: 'wh-note', text: sp.description }));
    const sell = button('wh-btn-danger', 'tag', 'Sell', async () => {
      const a = sim.animals.get(id);
      if (!a) return;
      const value = Math.max(0, -sim.sellAnimal(id, true).cost);
      const ok = await showDialog(this.host.uiRoot, {
        title: `Sell ${a.name}?`,
        text: `${a.name} will be rehomed to another zoo. You get ${fmtMoney(value)} back.`,
        ok: 'Sell',
        danger: true,
      });
      if (ok && sim.animals.has(id)) {
        const r = sim.sellAnimal(id);
        if (!r.ok) cue('error');
        else this.host.select(null);
      }
    });
    const move = button('wh-btn-ghost', 'move', 'Move', () => this.host.startMove({ kind: 'animal', id }));
    s.setFoot([this.makeFollow({ kind: 'animal', id }), move, sell]);
    let lastAlert = '';
    return {
      refresh: () => {
        const a = sim.animals.get(id);
        if (!a) return false;
        s.setTitle(a.name, `${escapeHtml(sp?.name ?? a.speciesId)} · <i>${escapeHtml(sp?.latin ?? '')}</i>`, true);
        happy.set(a.happiness);
        health.set(a.health);
        needs.forEach(([, key], i) => needMeters[i].set(a.needs[key]));
        setText(kvAct.v, animalActionLabel(a.action, sp));
        setText(kvAge.v, ageText(a.ageDays, a.growth));
        const hab = a.habitatId ? sim.world.habitats.get(a.habitatId) : undefined;
        setText(kvHab.v, hab ? hab.name : 'None');
        setText(kvSex.v, a.sex === 'M' ? 'Male' : 'Female');
        // an escaped animal has to be caught by staff first
        move.disabled = a.escaped;
        const al: string[] = [];
        if (a.escaped) al.push(`<span class="wh-tag bad">${icon('warn')}Escaped!</span>`);
        const preg = sim.pregnancy(a.id);
        if (preg) al.push(`<span class="wh-tag good">Expecting · day ${preg.day} of ${preg.of}</span>`);
        if (a.health < 0.35) al.push('<span class="wh-tag bad">Needs a vet</span>');
        const html = al.join('');
        if (html !== lastAlert) {
          lastAlert = html;
          alert.innerHTML = html;
        }
        return true;
      },
    };
  }

  // ------------------------------------------------------------ guest
  private guestView(id: number): PanelView | null {
    const sim = this.host.sim;
    if (!sim.guests.get(id)) return null;
    const s = this.sheet;
    s.setBadge(this.host.thumbs, null, 'guests');
    const happy = meter('Happiness', 'heart');
    happy.root.classList.add('big');
    const needs = [
      ['Fed', 'hunger', 'bowl'],
      ['Refreshed', 'thirst', 'drop'],
      ['Comfort', 'bladder', 'home'],
      ['Energy', 'energy', 'sun'],
      ['Fun', 'fun', 'sparkle'],
    ] as const;
    const nm = needs.map(([l, , ic]) => meter(l, ic));
    const kvMoney = kvItem('Wallet');
    const kvHold = kvItem('Holding');
    const kvSeen = kvItem('Species seen');
    const kvAct = kvItem('Doing');
    const thoughts = el('div', 'wh-list');
    s.body.append(
      el('div', 'wh-meters one', [happy.root]),
      sect('Thoughts', thoughts),
      sect('Needs', el('div', 'wh-meters', nm.map((m) => m.root))),
      sect('Details', el('div', 'wh-kv', [kvAct.root, kvMoney.root, kvHold.root, kvSeen.root])),
    );
    s.setFoot([this.makeFollow({ kind: 'guest', id })]);
    let lastThoughts = '';
    return {
      refresh: () => {
        const g = sim.guests.get(id);
        if (!g) return false;
        s.setTitle(g.name, `Visitor${g.appearance.child ? ' (child)' : ''} · ${GUEST_ACTION[g.action] ?? g.action}`);
        happy.set(g.happiness);
        needs.forEach(([, key], i) => nm[i].set(g.needs[key]));
        setText(kvMoney.v, fmtMoney(g.money));
        setText(kvHold.v, HOLDING[g.holding] ?? g.holding);
        setText(kvSeen.v, String(g.seenSpecies.length));
        setText(kvAct.v, GUEST_ACTION[g.action] ?? g.action);
        const list = g.thoughts.slice(-6).reverse();
        const html = list.length ? list.map((t) => `<div class="wh-thought">“${escapeHtml(t)}”</div>`).join('') : '<div class="wh-note">No strong opinions yet.</div>';
        if (html !== lastThoughts) {
          lastThoughts = html;
          thoughts.innerHTML = html;
        }
        return true;
      },
    };
  }

  // ------------------------------------------------------------ staff
  private staffView(id: number): PanelView | null {
    const sim = this.host.sim;
    const st0 = sim.staff.get(id);
    if (!st0) return null;
    const info = STAFF_INFO[st0.role];
    const s = this.sheet;
    s.setBadge(this.host.thumbs, { kind: 'staff', role: st0.role }, info.icon);
    const kvTask = kvItem('Current task');
    const kvAct = kvItem('Doing');
    const kvSal = kvItem('Wage');
    const kvToday = kvItem('Done today');
    kvTask.root.style.gridColumn = '1 / -1';
    kvToday.root.style.gridColumn = '1 / -1';
    s.body.append(sect('Work', el('div', 'wh-kv', [kvTask.root, kvToday.root, kvAct.root, kvSal.root])), el('p', { class: 'wh-note', text: info.description }));
    const fire = button('wh-btn-danger', 'close', 'Dismiss', async () => {
      const st = sim.staff.get(id);
      if (!st) return;
      // today's work so far is paid on leaving
      const owed = sim.staffSettlement(id);
      const ok = await showDialog(this.host.uiRoot, {
        title: `Dismiss ${st.name}?`,
        text: owed > 0
          ? `${st.name} is paid ${fmtMoney(owed)} for today's work and leaves the zoo. You will no longer pay their ${fmtMoney(st.salary)}/day wage.`
          : `${st.name} will leave the zoo. You will no longer pay their ${fmtMoney(st.salary)}/day wage.`,
        ok: owed > 0 ? `Pay ${fmtMoney(owed)} and dismiss` : 'Dismiss',
        danger: true,
      });
      if (ok && sim.staff.has(id)) {
        const r = sim.fireStaff(id);
        if (!r.ok) cue('error');
        else this.host.select(null);
      }
    });
    s.setFoot([this.makeFollow({ kind: 'staff', id }), fire]);
    const actName: Record<string, string> = { walk: 'Walking', idle: 'Waiting', work: 'Working' };
    return {
      refresh: () => {
        const st = sim.staff.get(id);
        if (!st) return false;
        s.setTitle(st.name, info.name);
        setText(kvTask.v, st.task || 'Patrolling');
        kvTask.v.title = st.task;
        setText(kvAct.v, actName[st.action] ?? st.action);
        setText(kvSal.v, `${fmtMoney(st.salary)}/day`);
        const work = sim.staffStats(id);
        setText(kvToday.v, work ? staffWorkText(st.role, work) : '—');
        return true;
      },
    };
  }

  // ------------------------------------------------------------ object
  private objectView(id: number): PanelView | null {
    const sim = this.host.sim;
    const o = sim.world.objects.get(id);
    if (!o) return null;
    const def = OBJECTS_BY_ID[o.defId];
    if (!def) return null;
    const s = this.sheet;
    s.setBadge(this.host.thumbs, { kind: 'object', defId: o.defId }, 'sparkle');
    s.setTitle(def.name, CATEGORY_NAME[def.category] ?? def.category);
    const items: HTMLElement[] = [];
    const add = (k: string, v: string) => {
      const kv = kvItem(k);
      kv.v.textContent = v;
      items.push(kv.root);
    };
    const [w, d] = rotatedSize(def, o.rot);
    add('Footprint', `${w * TILE} × ${d * TILE} m`);
    add('Upkeep', def.upkeep ? `${fmtMoney(def.upkeep)}/day` : 'None');
    add('Guest appeal', `${def.appeal}/10`);
    add('Cost', fmtMoney(def.cost));
    const removable = o.defId !== 'entrance_gate';
    const resale = kvItem('If removed');
    if (removable) items.push(resale.root);
    if (def.shop) add('Sells at', fmtMoney(def.shop.price));
    if (def.serves) add('Provides', def.serves === 'food' ? 'Food' : def.serves === 'water' ? 'Water' : def.serves === 'shelter' ? 'Shelter' : 'Play');
    const hab = sim.world.habitatAt(o.tx, o.tz);
    if (hab) add('In habitat', hab.name);
    // shops and restrooms: how today is going (sales, line, guests who gave up)
    const service = sim.serviceStats(id) ? { done: kvItem(def.shop ? 'Sold' : 'Visits'), line: kvItem('In line') } : null;
    if (service) s.body.append(sect('Today', el('div', 'wh-kv', [service.done.root, service.line.root])));
    s.body.append(el('p', { class: 'wh-note', text: def.description }), sect('Details', el('div', 'wh-kv', items)));
    if (def.biomes?.length) s.body.append(sect('Looks natural in', el('div', 'wh-tags', def.biomes.map((b) => el('span', { class: 'wh-tag', text: BIOME_NAME[b] })))));
    const foot: HTMLElement[] = [
      button('wh-btn-ghost', 'eye', 'View', () => {
        const c = sim.world.objectCenter(o);
        this.host.focusOn(c.x, c.z, 22);
      }),
    ];
    if (removable) {
      foot.push(
        button('wh-btn-ghost', 'move', 'Move', () => this.host.startMove({ kind: 'object', id })),
        button('wh-btn-danger', 'trash', 'Remove', async () => {
          if (!sim.world.objects.has(id)) return;
          const dry = sim.removeObject(id, true);
          if (!dry.ok) {
            cue('error');
            return;
          }
          const refund = Math.max(0, -dry.cost);
          const back = refund ? `${dry.refundFraction === 1 ? 'Full refund — just built. ' : ''}You get ${fmtMoney(refund)} back. ` : '';
          const ok = await showDialog(this.host.uiRoot, {
            title: `Remove ${def.name}?`,
            text: `${back}Fences and paths around it stay as they are.`,
            ok: 'Remove',
            danger: true,
          });
          if (!ok || !sim.world.objects.has(id)) return;
          const r = sim.removeObject(id);
          if (r.ok) {
            cue('bulldoze');
            this.host.select(null);
          } else cue('error');
        }),
      );
    }
    s.setFoot(foot);
    return {
      refresh: () => {
        if (!sim.world.objects.has(id)) return false;
        if (removable) {
          // the sim refunds in full for a short while after building (undoing a mis-tap)
          const dry = sim.removeObject(id, true);
          const refund = dry.ok ? Math.max(0, -dry.cost) : 0;
          const full = refund > 0 && dry.refundFraction === 1;
          setText(resale.v, full ? 'Full refund — just built' : refund ? `${fmtMoney(refund)} back` : 'No refund');
          resale.v.className = `wh-kv-v${full ? ' good' : ''}`;
          resale.root.style.gridColumn = full ? '1 / -1' : '';
        }
        const st = service && sim.serviceStats(id);
        if (service && st) {
          setText(service.done.v, def.shop ? `${st.sold} for ${fmtMoney(st.income)}` : String(st.visits));
          setText(service.line.v, `${st.queue} now${st.gaveUp ? ` · ${st.gaveUp} gave up` : ''}`);
          service.line.v.className = `wh-kv-v${st.gaveUp ? ' warn' : ''}`;
        }
        return true;
      },
    };
  }

  // ------------------------------------------------------------ habitat
  private habitatView(id: number): PanelView | null {
    const sim = this.host.sim;
    const w = sim.world;
    if (!w.habitats.get(id)) return null;
    const s = this.sheet;
    s.setBadge(this.host.thumbs, null, 'fence');
    const titleEl = s.titleEl();
    titleEl.classList.add('edit');
    const startRename = () => {
      const h = w.habitats.get(id);
      if (!h || titleEl.querySelector('input')) return;
      const input = el('input', {
        class: 'wh-input',
        attrs: { maxlength: '32', value: h.name, 'aria-label': 'Habitat name', enterkeyhint: 'done', autocomplete: 'off', spellcheck: 'false' },
      }) as HTMLInputElement;
      titleEl.textContent = '';
      titleEl.append(input);
      input.focus();
      input.select();
      let finished = false;
      const done = (save: boolean) => {
        if (finished) return;
        finished = true;
        const v = input.value.trim();
        const cur = w.habitats.get(id);
        if (save && v && cur && v !== cur.name) {
          const r = sim.renameHabitat(id, v);
          cue(r.ok ? 'tap' : 'error');
        }
        titleEl.textContent = '';
        lastTitle = '';
        renderTitle();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'Escape') {
          done(false);
        }
      });
      input.addEventListener('blur', () => done(true), { once: true });
    };
    titleEl.onclick = startRename;
    let lastTitle = '';
    const renderTitle = () => {
      const h = w.habitats.get(id);
      if (!h || titleEl.querySelector('input')) return;
      if (h.name === lastTitle) return;
      lastTitle = h.name;
      titleEl.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(h.name)}</span>${icon('pencil')}`;
    };

    const kvArea = kvItem('Area');
    const kvAnimals = kvItem('Animals');
    const kvFence = kvItem('Weakest fence');
    const kvView = kvItem('Guest view');
    const kvRoom = kvItem('Room');
    // full width: mixed fence names and the view and room texts need the room
    for (const kv of [kvFence, kvView, kvRoom]) kv.root.style.gridColumn = '1 / -1';
    const comp = compositionBar(new Array(TERRAIN_COUNT).fill(0));
    const residents = el('div', 'wh-list');
    const suitWrap = el('div');
    s.body.append(
      el('div', 'wh-kv', [kvArea.root, kvAnimals.root, kvRoom.root, kvFence.root, kvView.root]),
      sect('Terrain', comp.bar, comp.legend),
      sect('Suitability', suitWrap),
      sect('Residents', residents),
    );
    s.setFoot([
      button('wh-btn-ghost', 'eye', 'View', () => {
        const h = w.habitats.get(id);
        if (!h) return;
        const cx = ((h.minX + h.maxX + 1) / 2) * TILE,
          cz = ((h.minZ + h.maxZ + 1) / 2) * TILE;
        const span = Math.max(h.maxX - h.minX + 1, h.maxZ - h.minZ + 1) * TILE;
        this.host.focusOn(cx, cz, Math.max(18, span * 1.25));
      }),
      button('wh-btn-primary', 'paw', 'Adopt', () => this.host.openAnimals()),
    ]);
    const suitBlocks = new Map<string, ReturnType<typeof suitabilityBlock>>();
    let lastResidents = '';
    return {
      refresh: () => {
        const h = w.habitats.get(id);
        if (!h) return false;
        let rep: HabitatReport | null = null;
        try {
          rep = sim.habitatReport(id);
        } catch {
          rep = null;
        }
        renderTitle();
        const nAnimals = rep ? rep.animals.length : 0;
        s.setSub(`Habitat · ${h.tiles.length} tiles · ${nAnimals} animal${nAnimals === 1 ? '' : 's'}`);
        setText(kvArea.v, `${h.tiles.length * TILE * TILE} m²`);
        setText(kvAnimals.v, String(nAnimals));
        setText(kvFence.v, weakestFenceText(h));
        const view = guestViewText(rep ? rep.viewable : h.viewTiles.length > 0, h.viewQuality);
        setText(kvView.v, view.text);
        kvView.v.className = `wh-kv-v ${view.kind}`;
        // crowding is what hurts animals most: say it plainly (empty habitats have room by definition)
        const space = Math.min(1, ...(rep?.suitability ?? []).map((su) => su.space));
        const room = roomText(space, h.tiles.length);
        setText(kvRoom.v, room.text);
        kvRoom.v.className = `wh-kv-v ${room.kind}`;
        if (rep) comp.set(rep.terrainFractions);
        else {
          const tot = Math.max(1, h.tiles.length);
          comp.set(h.terrainCounts.map((c) => c / tot));
        }
        // suitability per species present
        const present = new Set<string>();
        for (const su of rep?.suitability ?? []) {
          present.add(su.speciesId);
          let b = suitBlocks.get(su.speciesId);
          if (!b) {
            b = suitabilityBlock(SPECIES_BY_ID[su.speciesId]?.name ?? su.speciesId);
            suitBlocks.set(su.speciesId, b);
            suitWrap.append(b.root);
          }
          b.set(su);
        }
        for (const [k, b] of suitBlocks)
          if (!present.has(k)) {
            b.root.remove();
            suitBlocks.delete(k);
          }
        if (!suitBlocks.size && !suitWrap.querySelector('.wh-note')) {
          suitWrap.append(el('div', { class: 'wh-note', text: 'No animals yet. Tap Adopt to see which species would thrive here.' }));
        } else if (suitBlocks.size) suitWrap.querySelector('.wh-note')?.remove();
        // residents
        const ids = rep?.animals ?? [];
        const key = ids.map((aid) => {
          const a = sim.animals.get(aid);
          return a ? `${aid}:${Math.round(a.happiness * 20)}` : '';
        }).join(',');
        if (key !== lastResidents) {
          lastResidents = key;
          residents.textContent = '';
          for (const aid of ids.slice(0, 24)) {
            const a = sim.animals.get(aid);
            if (!a) continue;
            const sp = SPECIES_BY_ID[a.speciesId];
            const li = el('div', 'wh-li tap', [
              iconEl(a.sex === 'M' ? 'male' : 'female'),
              el('div', 'wh-li-main', [el('div', { class: 'wh-li-t', text: a.name }), el('div', { class: 'wh-li-s', text: sp?.name ?? a.speciesId })]),
              el('span', { class: `wh-score ${levelClass(a.happiness)}`, text: fmtPct(a.happiness) }),
            ]);
            li.addEventListener('click', () => this.host.select({ kind: 'animal', id: aid }));
            residents.append(li);
          }
          if (!ids.length) residents.append(el('div', { class: 'wh-note', text: 'Empty for now.' }));
        }
        return true;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// species card (animal tool)

export class SpeciesCard {
  readonly sheet: Sheet;
  private speciesId = '';
  private suitWrap = el('div');
  private suit: ReturnType<typeof suitabilityBlock> | null = null;
  private cta = el('div', 'wh-suit-cta');

  constructor(
    private thumbs: ThumbnailService,
    onClose: () => void,
  ) {
    this.sheet = new Sheet('left', onClose);
  }

  show(speciesId: string): void {
    const sp = SPECIES_BY_ID[speciesId];
    if (!sp) return;
    if (speciesId !== this.speciesId) {
      this.speciesId = speciesId;
      const s = this.sheet;
      s.reset();
      s.setBadge(this.thumbs, { kind: 'animal', speciesId }, 'paw');
      s.setTitle(sp.name, `<span class="wh-biome">${escapeHtml(BIOME_NAME[sp.biome])}</span> · <i>${escapeHtml(sp.latin)}</i>`, true);
      const terr = Object.entries(sp.terrain)
        .map(([k, v]) => ({ t: Number(k) as Terrain, v: v ?? 0 }))
        .sort((a, b) => b.v - a.v)
        .map((x) => `<span class="wh-tag"><i style="background:${TERRAIN_INFO[x.t].color}"></i>${TERRAIN_INFO[x.t].name} ${Math.round(x.v * 100)}%</span>`)
        .join('');
      const likes = sp.likes
        .map((id) => OBJECTS_BY_ID[id]?.name)
        .filter(Boolean)
        .slice(0, 8)
        .map((n) => `<span class="wh-tag">${escapeHtml(n!)}</span>`)
        .join('');
      const kv = (k: string, v: string, wide = false) =>
        `<div class="wh-kv-item"${wide ? ' style="grid-column:1/-1"' : ''}><div class="wh-kv-k">${k}</div><div class="wh-kv-v${wide ? ' wrap' : ''}">${escapeHtml(v)}</div></div>`;
      const facts = el('div', {
        class: 'wh-kv',
        html:
          kv('Group size', `${sp.groupMin}–${sp.groupMax}`) +
          kv('Space each', `${sp.spacePerAnimal} tiles`) +
          kv('Guest appeal', `${sp.appeal}/10`) +
          kv('Cost', fmtMoney(sp.cost)) +
          kv(`Fence needed · strength ${sp.danger}/4 or more`, fenceAdvice(sp.danger), true),
      });
      this.suit = null;
      this.suitWrap.textContent = '';
      this.cta.innerHTML = `${icon('target')}<span>Tap inside a fenced habitat to see how well it suits a ${escapeHtml(sp.name.toLowerCase())}.</span>`;
      s.body.append(
        el('p', { class: 'wh-note', text: sp.description }),
        sect('Prefers terrain', el('div', { class: 'wh-tags', html: terr })),
        sect('Likes', el('div', { class: 'wh-tags', html: likes })),
        facts,
        sect('This spot', this.suitWrap, this.cta),
      );
    }
    this.sheet.show();
  }

  setSuitability(s: SpeciesSuitability | null, habitatName: string | null, reason: string | null): void {
    if (!s) {
      if (this.suit) {
        this.suit.root.remove();
        this.suit = null;
      }
      this.cta.style.display = '';
      if (reason) this.cta.innerHTML = `${icon('warn')}<span>${escapeHtml(reason)}</span>`;
      return;
    }
    this.cta.style.display = 'none';
    if (!this.suit) {
      this.suit = suitabilityBlock(habitatName ?? 'Habitat');
      this.suitWrap.append(this.suit.root);
      const body = this.sheet.body;
      body.scrollTo({ top: Math.max(0, this.suitWrap.offsetTop - body.offsetTop - 34), behavior: 'smooth' });
    }
    const nameEl = this.suit.root.querySelector('.wh-suit-name');
    if (nameEl) setText(nameEl, habitatName ?? 'Habitat');
    this.suit.set(s);
  }

  hide(): void {
    this.sheet.hide();
  }

  get visible(): boolean {
    return this.sheet.open;
  }
}

/** Tile rect → world centre helper (habitat bounding boxes). */
export function habitatCentre(h: { minX: number; maxX: number; minZ: number; maxZ: number }): { x: number; z: number } {
  return { x: ((h.minX + h.maxX + 1) / 2) * TILE, z: ((h.minZ + h.maxZ + 1) / 2) * TILE };
}
