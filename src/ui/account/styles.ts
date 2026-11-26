// Styles of the account screens (player chip, picker, setup, manage, grown-up check, sync
// prompts, backups, badge, Settings section), injected once. They build on the shell's tokens
// (--wh-*) and classes (.wh-btn, .wh-glass-2, .wh-dialog, .wh-screen); everything here is
// prefixed wh-ac-. Every tap target is at least 44 px tall (kids).
import { ensureStyles } from '../styles';

const CSS = `
/* ------------------------------------------------------------ overlay layer (above the menu and loading screens) */
.wh-screen.wh-ac-layer { z-index: 150; pointer-events: none; background: none; transition: none; }
.wh-ac-layer > * { pointer-events: auto; }
.wh-ac-layer .wh-dialog-back { position: fixed; z-index: auto; }
.wh-ac-dialog { width: min(420px, 100%); max-height: calc(100% - 8px); overflow-y: auto; scrollbar-width: none; }
.wh-ac-dialog::-webkit-scrollbar { display: none; }
.wh-ac-dialog.wide { width: min(640px, 100%); }
.wh-ac-dialog h3 { font-size: 19px; line-height: 1.25; }
.wh-ac-dialog p { font-size: 15px; color: rgba(243,238,226,.82); }
.wh-ac-dialog .wh-dialog-btns .wh-btn { min-height: 48px; font-size: 15.5px; }
.wh-ac-signin .wh-dialog-btns .wh-btn:first-child { flex: 0 0 auto; padding: 0 20px; }
.wh-ac-signin .wh-dialog-btns .wh-btn:last-child { flex: 1 1 auto; }
.wh-ac-g { display: inline-flex; flex: none; }
.wh-ac-err { color: #f3ad97; font-size: 14px; font-weight: 650; min-height: 20px; margin: -6px 0 10px; }
.wh-ac-err:empty { display: none; }
.wh-ac-busy { display: flex; align-items: center; gap: 10px; justify-content: center; min-height: 48px; color: var(--wh-muted); font-weight: 650; }
.wh-ac-busy .wh-spin { width: 22px; height: 22px; }

/* ------------------------------------------------------------ title menu additions */
.wh-ac-chip {
  position: absolute; top: var(--wh-gt); right: var(--wh-gr); z-index: 2; pointer-events: auto;
  height: 48px; min-height: 48px; padding: 0 14px 0 6px; border-radius: 24px; gap: 8px; font-size: 15.5px; font-weight: 750; max-width: 46vw;
}
.wh-ac-chip.signin { padding: 0 16px 0 12px; }
.wh-ac-chip .wh-ac-av { width: 36px; height: 36px; }
.wh-ac-chip .wh-ac-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wh-ac-chip .wh-ico { width: 18px; height: 18px; }
.wh-ac-chip .wh-ac-chip-warn { color: var(--wh-amber); }
.wh-menu.wh-ac-has-chip .wh-menu-card { margin-top: 36px; max-height: calc(100% - 64px); }
.wh-menu-row2 { display: flex; gap: 8px; width: 100%; }
.wh-menu-row2 .wh-btn { flex: 1.35 1 0; min-width: 0; height: 44px; font-size: 15px; border-radius: 14px; position: relative; padding: 0 10px; gap: 6px; }
.wh-menu-row2 .wh-btn[data-menu="versus"] { flex: 1 1 0; }
.wh-menu-btns .wh-menu-row2 .wh-btn { height: 46px; }
.wh-menu-btns .wh-btn .wh-btn-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wh-ac-dot { position: absolute; top: 6px; right: 8px; width: 10px; height: 10px; border-radius: 50%; background: #e2543d; box-shadow: 0 0 0 2px rgba(17,23,19,.85); }
.wh-menu-q.wh-ac-q { align-items: flex-end; margin-top: 12px; }
.wh-ac-learn { min-height: 44px; padding: 0 6px; background: none; border: 0; color: var(--wh-leaf-2); font-weight: 700; font-size: 15px; text-decoration: underline; text-underline-offset: 3px; }
.wh-ac-learn .wh-ico { width: 18px; height: 18px; }
.wh-ac-gfx { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.wh-ac-gfx > span { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--wh-faint); padding-right: 6px; }
.wh-ac-gfx .wh-segtext .wh-btn { height: 44px; min-height: 44px; padding: 0 11px; }
.wh-ac-foot-btn { min-height: 44px; margin-top: 6px; background: none; border: 0; color: var(--wh-amber); font-weight: 700; font-size: 14px; }
.wh-ac-foot-btn .wh-ico { width: 18px; height: 18px; }
@media (max-height: 380px) {
  .wh-menu-btns { gap: 8px; }
  .wh-menu-q.wh-ac-q { margin-top: 8px; }
  .wh-menu-foot { margin-top: 8px; }
}

/* ------------------------------------------------------------ full-screen account pages (picker, manage, setup, whose zoo) */
.wh-ac-page { z-index: 120; background: radial-gradient(120% 100% at 50% 0%, #20372a 0%, #102017 55%, #09130d 100%); align-items: stretch; justify-content: stretch; touch-action: pan-y; }
.wh-ac-col { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; max-width: 980px; margin: 0 auto; padding: var(--wh-gt) var(--wh-gr) var(--wh-gb) var(--wh-gl); gap: 8px; }
.wh-ac-head { display: flex; align-items: center; gap: 10px; min-height: 48px; flex: none; }
.wh-ac-head h2 { margin: 0; font-size: 22px; font-weight: 800; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-ac-head .wh-btn-icon { width: 48px; height: 48px; border-radius: 24px; flex: none; }
.wh-ac-head .wh-ac-headbtn { height: 48px; border-radius: 24px; flex: none; }
.wh-ac-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; display: flex; flex-direction: column; gap: 10px; padding-bottom: 4px; }
.wh-ac-body::-webkit-scrollbar { display: none; }
.wh-ac-note { font-size: 13.5px; color: var(--wh-muted); line-height: 1.4; }
.wh-ac-note.warn { color: var(--wh-amber); font-weight: 650; }
.wh-ac-h3 { margin: 6px 0 0; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--wh-sand); }
.wh-ac-av { display: inline-flex; flex: none; border-radius: 50%; overflow: hidden; line-height: 0; }
.wh-ac-av svg { display: block; width: 100%; height: 100%; }
.wh-ac-av.guest { background: rgba(255,255,255,.12); border: 2px solid rgba(255,255,255,.22); align-items: center; justify-content: center; color: var(--wh-sand); }
.wh-ac-av.guest .wh-ico { width: 58%; height: 58%; }

/* who's playing? */
.wh-ac-grid { display: grid; grid-template-columns: repeat(auto-fill, 132px); gap: 10px; justify-content: center; }
.wh-ac-tile {
  appearance: none; font: inherit; color: inherit; cursor: pointer; position: relative; width: 132px; height: 120px; border-radius: 20px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 8px 6px;
  background: linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,.04)); border: 1px solid var(--wh-line-2);
  transition: transform .12s ease, background-color .2s ease; touch-action: manipulation; pointer-events: auto;
}
.wh-ac-tile:active { transform: scale(.96); }
.wh-ac-tile:disabled { opacity: .45; cursor: default; transform: none; }
.wh-ac-tile .wh-ac-av { width: 56px; height: 56px; }
.wh-ac-tile b { font-size: 15.5px; font-weight: 800; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh-ac-tile small { font-size: 12px; color: var(--wh-muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh-ac-tile.last { border: 2px solid var(--wh-leaf-2); box-shadow: 0 0 0 3px rgba(151,196,108,.22); background: linear-gradient(180deg, rgba(151,196,108,.20), rgba(151,196,108,.06)); }
.wh-ac-tile.add { border-style: dashed; background: rgba(255,255,255,.04); }
.wh-ac-tile.add .wh-ac-plus { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: rgba(151,196,108,.18); color: var(--wh-leaf-2); }
.wh-ac-tile.add .wh-ac-plus .wh-ico { width: 30px; height: 30px; }
.wh-ac-tile .wh-ac-state { position: absolute; top: 8px; left: 9px; width: 18px; height: 18px; color: var(--wh-faint); }
.wh-ac-tile .wh-ac-state .wh-ico { width: 18px; height: 18px; }
.wh-ac-tile .wh-ac-state.synced { color: var(--wh-leaf); }
.wh-ac-tile .wh-ac-state.conflict { color: var(--wh-amber); }
.wh-ac-tile .wh-ac-mark { position: absolute; top: 6px; right: 7px; min-width: 24px; height: 24px; border-radius: 12px; padding: 0 6px; display: grid; place-items: center; font-weight: 900; font-size: 14px; background: var(--wh-amber); color: #2e2108; }
.wh-ac-tile .wh-ac-mark.blocked { background: var(--wh-clay); color: #2b130b; font-size: 12px; }

/* manage players */
.wh-ac-list { display: flex; flex-direction: column; gap: 8px; }
.wh-ac-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 16px; background: rgba(255,255,255,.06); border: 1px solid var(--wh-line); min-height: 60px; }
.wh-ac-row .wh-ac-av { width: 44px; height: 44px; }
.wh-ac-row-t { flex: 1; min-width: 0; }
.wh-ac-row-t b { display: block; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh-ac-row-t small { display: block; font-size: 12.5px; color: var(--wh-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh-ac-row .wh-btn { flex: none; height: 44px; border-radius: 13px; padding: 0 12px; }
.wh-ac-row.removed { opacity: .85; border-style: dashed; }
@media (max-width: 700px) { .wh-ac-row .wh-btn .wh-btn-label { display: none; } .wh-ac-row .wh-btn { width: 44px; padding: 0; } }

/* player setup (first player, add, edit) */
.wh-ac-setup { display: flex; gap: 18px; align-items: flex-start; }
.wh-ac-setup-l { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.wh-ac-setup-r { flex: 0 1 400px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.wh-ac-preview { width: 84px; height: 84px; }
.wh-ac-name {
  width: 100%; height: 52px; border-radius: 14px; border: 2px solid var(--wh-line-2); background: rgba(0,0,0,.25); color: var(--wh-text);
  font: inherit; font-size: 20px; font-weight: 750; padding: 0 14px; outline: none; pointer-events: auto; user-select: text; -webkit-user-select: text;
}
.wh-ac-name:focus { border-color: var(--wh-leaf-2); }
.wh-ac-name.bad { border-color: var(--wh-clay); }
.wh-ac-hint { font-size: 12.5px; color: var(--wh-muted); line-height: 1.35; text-align: center; }
.wh-ac-namemsg { font-size: 14px; font-weight: 700; min-height: 19px; color: #f3ad97; text-align: center; }
.wh-ac-namemsg.ok { color: var(--wh-leaf-2); }
.wh-ac-animals { display: grid; grid-template-columns: repeat(5, 60px); gap: 8px; justify-content: center; }
.wh-ac-animal { width: 60px; height: 60px; min-height: 60px; padding: 0; border-radius: 50%; border: 3px solid transparent; background: none; }
.wh-ac-animal .wh-ac-av { width: 100%; height: 100%; }
.wh-ac-animal.on { border-color: #fff4d2; box-shadow: 0 0 0 3px rgba(151,196,108,.55); }
.wh-ac-colors { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
.wh-ac-color { width: 44px; height: 44px; min-width: 44px; padding: 0; border-radius: 50%; border: 3px solid rgba(255,255,255,.15); }
.wh-ac-color.on { border-color: #fff4d2; box-shadow: 0 0 0 3px rgba(151,196,108,.55); }
.wh-ac-actions { display: flex; gap: 10px; justify-content: flex-end; flex: none; }
.wh-ac-actions .wh-btn { min-width: 140px; height: 52px; font-size: 16.5px; border-radius: 16px; }

/* whose zoo is this? */
.wh-ac-zoocard { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 18px; background: rgba(228,208,160,.10); border: 1px solid rgba(228,208,160,.30); flex: none; }
.wh-ac-zoocard .wh-ac-zooic { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; background: linear-gradient(160deg, #b8da8c, #6e9e4a); color: #16230f; flex: none; }
.wh-ac-zoocard b { display: block; font-size: 17px; }
.wh-ac-zoocard span { display: block; font-size: 13px; color: var(--wh-muted); }

/* ------------------------------------------------------------ grown-up check */
.wh-ac-gate { display: flex; gap: 18px; align-items: stretch; }
.wh-ac-gate-l { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.wh-ac-gate-q { font-size: 26px; font-weight: 900; letter-spacing: .02em; color: #fff4d2; }
.wh-ac-gate-ans { height: 52px; border-radius: 14px; background: rgba(0,0,0,.3); border: 2px solid var(--wh-line-2); display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 900; letter-spacing: .12em; }
.wh-ac-gate-ans.bad { border-color: var(--wh-clay); animation: wh-ac-shake .35s ease; }
@keyframes wh-ac-shake { 20%, 60% { transform: translateX(-6px); } 40%, 80% { transform: translateX(6px); } }
.wh-ac-keys { display: grid; grid-template-columns: repeat(3, 58px); grid-auto-rows: 44px; gap: 6px; flex: none; }
.wh-ac-keys .wh-btn { height: 44px; min-width: 0; padding: 0; font-size: 21px; font-weight: 800; border-radius: 12px; }
.wh-ac-keys .wh-btn.ok { font-size: 16px; }
.wh-ac-gate-l .wh-dialog-btns { margin-top: auto; }
@media (max-width: 520px) { .wh-ac-gate { flex-direction: column; } .wh-ac-keys { justify-content: center; } }

/* ------------------------------------------------------------ two-card choice (conflict, lease lost) */
.wh-ac-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.wh-ac-card { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 12px 12px 10px; border-radius: 18px; background: rgba(255,255,255,.06); border: 1px solid var(--wh-line-2); min-width: 0; }
.wh-ac-card.newest { border: 2px solid var(--wh-leaf-2); background: linear-gradient(180deg, rgba(151,196,108,.16), rgba(151,196,108,.05)); }
.wh-ac-card-h { display: flex; align-items: center; gap: 8px; font-size: 16.5px; font-weight: 800; min-width: 0; }
.wh-ac-card-h .wh-ac-av { width: 32px; height: 32px; }
.wh-ac-card-h span { overflow: hidden; min-width: 0; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.wh-ac-card-l { font-size: 13.5px; color: rgba(243,238,226,.84); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-ac-card-l.more { color: var(--wh-leaf-2); font-weight: 750; }
.wh-ac-card-l.faint { color: var(--wh-faint); }
.wh-ac-card .wh-btn { margin-top: 6px; height: 48px; font-size: 15.5px; }
.wh-ac-ribbon { position: absolute; top: -9px; right: 12px; padding: 2px 10px; border-radius: 10px; font-size: 11.5px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; background: var(--wh-leaf-2); color: #16230f; }
@media (max-width: 460px) { .wh-ac-cards { grid-template-columns: 1fr; } }

/* ------------------------------------------------------------ toast */
.wh-ac-toast { position: fixed; top: calc(var(--wh-gt) + 6px); left: 50%; transform: translateX(-50%); max-width: min(520px, 92vw); display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 18px; font-size: 15px; font-weight: 650; pointer-events: none; animation: wh-fade .25s ease both; }
.wh-ac-toast .wh-ico { color: var(--wh-leaf-2); }
.wh-ac-toast.out { opacity: 0; transition: opacity .4s ease; }

/* ------------------------------------------------------------ HUD cloud badge */
.wh-ac-badge { width: 44px; height: 44px; min-width: 44px; border-radius: 22px; padding: 0; position: relative; color: var(--wh-muted); transition: opacity .6s ease, color .2s ease; }
.wh-ac-badge .wh-ico { width: 24px; height: 24px; }
.wh-ac-badge.synced { color: var(--wh-leaf-2); }
.wh-ac-badge.faded { opacity: .45; }
.wh-ac-badge.offline, .wh-ac-badge.signin { color: var(--wh-faint); }
.wh-ac-badge.conflict, .wh-ac-badge.error { color: var(--wh-amber); }
.wh-ac-badge .wh-spin { width: 20px; height: 20px; }
.wh-ac-badge .wh-ac-bang { position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px; border-radius: 9px; background: var(--wh-amber); color: #2e2108; font-size: 12px; font-weight: 900; line-height: 18px; text-align: center; box-shadow: 0 0 0 2px rgba(17,23,19,.85); }

/* ------------------------------------------------------------ Settings section */
.wh-ac-sect { display: flex; flex-direction: column; }
.wh-ac-sect .wh-setting .wh-btn { flex: none; }
.wh-ac-sect .wh-ac-status { display: flex; align-items: center; gap: 6px; }
.wh-ac-sect .wh-ac-status .wh-ico { width: 16px; height: 16px; }
.wh-ac-sect .wh-ac-status.good { color: var(--wh-leaf-2); }
.wh-ac-sect .wh-ac-status.warn { color: var(--wh-amber); }
.wh-ac-btnrow { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--wh-line); }
.wh-ac-btnrow .wh-btn { height: 44px; }
.wh-ac-sect .wh-ac-inline-av { width: 28px; height: 28px; vertical-align: middle; margin-right: 6px; }
`;

let injected = false;

export function ensureAccountStyles(): void {
  ensureStyles();
  if (injected || typeof document === 'undefined') return;
  if (document.getElementById('wh-ac-styles')) {
    injected = true;
    return;
  }
  const s = document.createElement('style');
  s.id = 'wh-ac-styles';
  s.textContent = CSS;
  document.head.appendChild(s);
  injected = true;
}
