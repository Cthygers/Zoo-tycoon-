// UI extension contract: the existing UI (ui-shell) is the host; the tutorial, account and versus
// features are extensions mounted by createGameUI from UIDeps.extensions. Types only.
import type { EventBus, NotifyKind } from './events';
import type { BootIntent, IAudio, IEntityViews, IRenderContext, ISimulation, PlayerInfo, SimSpeed } from './contracts';
import type { CommandResult, SelectionRef, Tool } from './types';

export interface UIRect { left: number; top: number; right: number; bottom: number }
export interface PendingInfo { kind: Tool['kind']; ok: boolean; risky: boolean; note: string | null; noteKind: 'warning' | 'reason' | null }
export interface GestureSummary { pan: number; zoom: number; turn: number; tilt: number; fingers: 1 | 2; tap: boolean }
export interface SpeedLock { owner: string; onBlocked(): void }
export interface PillStepView { label: string; sub: string; fraction: number }
export interface SettingsSection { id: string; order: number; render(): HTMLElement }
export type ZooPanelEvent = { kind: 'shown'; tab: string } | { kind: 'closed' };

export interface UIExtensionHost {
  readonly root: HTMLElement;                 // the .wh-ui layer; extensions append their own overlays here
  readonly sim: ISimulation;
  readonly ctx: IRenderContext;
  readonly views: IEntityViews;
  readonly audio: IAudio;
  readonly events: EventBus;
  readonly player: PlayerInfo | null;
  save(): 'saved' | 'showcase' | 'kept' | 'failed';
  switchSlot(target: BootIntent): Promise<void>;          // rejects when main.ts gave none
  // HUD
  hudSlot(name: 'speed' | 'badge'): HTMLElement;          // 'speed' replaces the speed group while it has children; 'badge' sits left of the menu button
  hudEl(name: 'money' | 'speedGroup' | 'menu' | 'pill'): HTMLElement | null;
  hudSpeedButton(s: SimSpeed): HTMLElement | null;
  setSpeed(s: SimSpeed, source: 'hud' | 'key' | 'ext'): boolean;   // false when refused (versus, or a lock and source !== 'ext')
  setSpeedLock(lock: SpeedLock | null): void;
  setPillStep(view: PillStepView | null): void;
  onPillTapped(fn: () => void): () => void;
  // build UI
  tool(): { tool: Tool; moving: boolean };
  pending(): PendingInfo | null;
  openCategory(id: string | null): void;
  openedCategory(): string | null;
  categoryButton(id: string): HTMLElement | null;
  card(match: (key: string) => boolean): HTMLElement | null;
  revealCard(card: HTMLElement): void;
  drawer(): HTMLElement | null;
  toolBar(): HTMLElement | null;
  confirmBar(): HTMLElement | null;
  confirmOk(): HTMLElement | null;
  endTool(): void;
  closeDrawer(): void;
  select(sel: SelectionRef | null): void;
  selection(): SelectionRef | null;
  sheet(): { root: HTMLElement | null; close: HTMLElement | null; anchor(name: 'happiness'): HTMLElement | null };
  // zoo menu and dialogs
  openMenu(tab?: string): void;
  zooPanel(): { tab: string | null; close: HTMLElement | null; tabButton(t: string): HTMLElement | null; headGap(): { x0: number; x1: number; top: number } | null };
  onZooPanel(fn: (e: ZooPanelEvent) => void): () => void;
  addSettingsSection(s: SettingsSection): () => void;
  hideSettingsRow(row: 'newZoo', hidden: boolean): void;
  dialogOpen(): boolean;
  showDialog(o: { title: string; text: string; ok: string; cancel?: string; danger?: boolean; primary?: 'ok' | 'cancel' }): Promise<boolean>;
  notify(text: string, kind?: NotifyKind): void;
  // view, camera, input
  viewArea(): UIRect;
  clearArea(): UIRect;
  workRect(): UIRect | null;
  focusClear(x: number, z: number, distance?: number): void;
  cameraDemo(kind: 'pan' | 'zoom' | 'turn'): Promise<void>;
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
  pointersDown(): number;
  onGesture(fn: (g: GestureSummary) => void): () => void;
  /** Run a sim command with the normal UI feedback (commandResult event, cue, money popup). */
  runCommand(fn: () => CommandResult, at?: { x: number; z: number }): CommandResult;
  /** Screen areas toasts and the camera's clear area must avoid (e.g. the tutorial bubble). */
  setReservedRect(id: string, r: UIRect | null): void;
}

export interface UIExtension {
  readonly id: string;
  mount(host: UIExtensionHost): void;
  update?(dt: number): void;                  // every frame after the shell's own update
  handleBack?(): boolean;                     // asked after dialogs, before the shell's panels
  onKey?(code: string): boolean;              // asked before the shell's key handling
  dispose?(): void;
}
