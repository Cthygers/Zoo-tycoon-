// All UI styling, injected once as a <style> element. Design language:
// frosted dark-glass panels, warm natural accents (leaf green, savanna sand),
// generous 44 px+ touch targets, safe-area aware, landscape first.

const CSS = /* css */ `
.wh-ui, .wh-screen {
  --wh-glass: rgba(20, 27, 22, 0.58);
  --wh-glass-2: rgba(17, 23, 19, 0.80);
  --wh-glass-solid: rgba(22, 29, 24, 0.94);
  --wh-line: rgba(255, 246, 226, 0.10);
  --wh-line-2: rgba(255, 246, 226, 0.18);
  --wh-text: #f3eee2;
  --wh-muted: rgba(243, 238, 226, 0.64);
  --wh-faint: rgba(243, 238, 226, 0.40);
  --wh-leaf: #97c46c;
  --wh-leaf-2: #b8da8c;
  --wh-leaf-deep: #4e7a34;
  --wh-sand: #e4d0a0;
  --wh-clay: #e88466;
  --wh-amber: #ebb854;
  --wh-sky: #82bfd6;
  --wh-r: 16px;
  --wh-sat: env(safe-area-inset-top, 0px);
  --wh-sab: env(safe-area-inset-bottom, 0px);
  --wh-sal: env(safe-area-inset-left, 0px);
  --wh-sar: env(safe-area-inset-right, 0px);
  --wh-gl: max(10px, var(--wh-sal));
  --wh-gr: max(10px, var(--wh-sar));
  --wh-gt: max(8px, var(--wh-sat));
  --wh-gb: max(8px, var(--wh-sab));
  --wh-top-h: 52px;
  --wh-cats-h: 64px;
  font-family: "Inter", "Roboto", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.35;
  color: var(--wh-text);
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}
/* overflow: clip (not hidden) so no scrollIntoView / focus() / keyboard resize can scroll the whole HUD layer sideways */
.wh-ui { position: absolute; inset: 0; pointer-events: none; overflow: hidden; overflow: clip; }
.wh-ui * , .wh-screen * { box-sizing: border-box; }
.wh-ico { width: 22px; height: 22px; display: block; flex: none; }
.wh-icon-wrap { display: inline-flex; align-items: center; justify-content: center; }

.wh-glass {
  background: linear-gradient(180deg, rgba(34, 43, 36, 0.62), rgba(18, 24, 20, 0.62));
  -webkit-backdrop-filter: blur(16px) saturate(1.35);
  backdrop-filter: blur(16px) saturate(1.35);
  border: 1px solid var(--wh-line);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.wh-glass-2 {
  background: linear-gradient(180deg, rgba(30, 38, 32, 0.86), rgba(16, 21, 18, 0.88));
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  backdrop-filter: blur(20px) saturate(1.3);
  border: 1px solid var(--wh-line);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.07);
}
.wh-noblur .wh-glass { -webkit-backdrop-filter: none; backdrop-filter: none; background: rgba(22, 29, 24, 0.86); }
.wh-noblur .wh-glass-2 { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--wh-glass-solid); }

/* ------------------------------------------------------------ buttons */
.wh-btn {
  appearance: none; border: 0; margin: 0; background: transparent; color: inherit; font: inherit;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-width: 44px; min-height: 44px; padding: 0 12px; border-radius: 12px; cursor: pointer;
  transition: background-color .16s ease, color .16s ease, transform .12s ease, opacity .2s ease, box-shadow .2s ease;
  touch-action: manipulation; pointer-events: auto; white-space: nowrap; outline: none;
}
.wh-btn:active { transform: scale(0.95); }
.wh-btn:disabled { opacity: .42; cursor: default; transform: none; }
.wh-btn-label { font-weight: 600; }
.wh-btn-ghost { background: rgba(255, 255, 255, 0.07); border: 1px solid var(--wh-line); }
.wh-btn-primary {
  background: linear-gradient(180deg, #a6d17b, #7eae55); color: #16230f; font-weight: 700;
  box-shadow: 0 4px 14px rgba(110, 160, 70, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.35);
}
.wh-btn-danger { background: rgba(232, 132, 102, 0.14); color: #f3ad97; border: 1px solid rgba(232, 132, 102, 0.32); }
.wh-btn-icon { padding: 0; width: 44px; }
.wh-btn:focus-visible { box-shadow: 0 0 0 2px var(--wh-leaf-2); }
@media (hover: hover) {
  .wh-btn-ghost:hover { background: rgba(255, 255, 255, 0.12); }
  .wh-btn-primary:hover { filter: brightness(1.06); }
}

/* ------------------------------------------------------------ top bar */
.wh-top {
  position: absolute; top: var(--wh-gt); left: var(--wh-gl); right: var(--wh-gr);
  display: grid; grid-template-columns: auto 1fr auto auto; grid-template-areas: "left mid speed menu";
  align-items: center; gap: 8px; pointer-events: none;
}
.wh-top-left { grid-area: left; display: flex; gap: 8px; }
.wh-top-mid { grid-area: mid; display: flex; gap: 8px; justify-self: center; }
.wh-top-speed { grid-area: speed; }
.wh-top-menu { grid-area: menu; display: flex; align-items: center; gap: 8px; }
/* extension slots: 'speed' takes the speed group's place while it has something in it (the versus clock),
   'badge' sits left of the menu button (the cloud badge) */
.wh-top-slot { pointer-events: auto; display: flex; align-items: center; gap: 6px; min-width: 0; }
.wh-slot-speed { grid-area: speed; }
.wh-top-slot:empty, .wh-top-slot.hidden, .wh-top-speed.hidden { display: none; }
.wh-chip {
  pointer-events: auto; height: 44px; padding: 0 14px 0 11px; border-radius: 22px;
  display: inline-flex; align-items: center; gap: 8px; font-weight: 650; font-size: 15px; letter-spacing: .01em;
  cursor: pointer; transition: transform .12s ease, background-color .2s ease; white-space: nowrap;
}
.wh-chip:active { transform: scale(0.96); }
.wh-chip .wh-ico { width: 20px; height: 20px; }
.wh-chip-money .wh-ico { color: var(--wh-sand); }
.wh-chip-money.neg { color: #ff9c80; }
.wh-chip-money.neg .wh-ico { color: #ff9c80; }
.wh-chip-money .wh-money-delta { font-size: 12px; font-weight: 700; margin-left: 2px; opacity: 0; transition: opacity .3s; }
.wh-chip-money .wh-money-delta.up { color: var(--wh-leaf-2); opacity: 1; }
.wh-chip-money .wh-money-delta.down { color: #ff9c80; opacity: 1; }
.wh-chip-clock .wh-day { color: var(--wh-muted); font-weight: 600; }
.wh-chip-clock .wh-ico { color: #f2c46d; }
.wh-chip-clock.night .wh-ico { color: #b9c8ef; }
.wh-chip-clock .wh-open { width: 7px; height: 7px; border-radius: 50%; background: var(--wh-leaf); box-shadow: 0 0 8px var(--wh-leaf); }
.wh-chip-clock .wh-open.closed { background: #8b8578; box-shadow: none; }
.wh-chip-guests .wh-ico { color: var(--wh-sky); }
/* "138/141": guests in the zoo of how many fit (amber while arrivals wait for room) */
.wh-guests-cap { font-size: 12.5px; font-weight: 600; color: var(--wh-muted); margin-left: 1px; }
.wh-guests-cap.full { color: var(--wh-amber); }
.wh-stars { display: inline-flex; gap: 1px; position: relative; }
.wh-stars .wh-ico { width: 15px; height: 15px; }
.wh-stars-bg { color: rgba(255, 255, 255, 0.18); display: inline-flex; gap: 1px; }
.wh-stars-fg { color: #f1c25c; display: inline-flex; gap: 1px; position: absolute; left: 0; top: 0; overflow: hidden; white-space: nowrap; transition: width .6s ease; }
.wh-rating-num { font-size: 13px; color: var(--wh-muted); font-weight: 600; }
.wh-seg { pointer-events: auto; display: inline-flex; padding: 3px; gap: 2px; border-radius: 24px; height: 46px; align-items: center; position: relative; }
/* held by a UI extension (the tutorial while you build): dimmed with a lock, but still tappable so it can say why */
.wh-seg.locked .wh-btn { opacity: .5; }
.wh-seg.locked .wh-btn.on { opacity: .75; }
.wh-seg-lock {
  position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 10px; display: grid; place-items: center;
  background: var(--wh-amber); color: #2e2108; pointer-events: none; box-shadow: 0 0 0 2px rgba(17, 23, 19, .85);
}
.wh-seg-lock .wh-ico { width: 12px; height: 12px; stroke-width: 2.4; }
.wh-seg-lock.hidden { display: none; }
.wh-seg .wh-btn { min-width: 40px; width: 40px; height: 38px; min-height: 38px; padding: 0; border-radius: 19px; color: var(--wh-muted); position: relative; }
/* 44 px tall touch targets without changing the pill's look */
.wh-seg .wh-btn::after { content: ""; position: absolute; inset: -4px -1px; }
.wh-seg .wh-btn .wh-ico { width: 18px; height: 18px; }
.wh-seg .wh-btn.on { background: var(--wh-leaf); color: #142010; box-shadow: 0 2px 10px rgba(130, 180, 90, .35); }
.wh-seg .wh-btn.on.paused { background: var(--wh-amber); }
.wh-menubtn { pointer-events: auto; width: 46px; height: 46px; border-radius: 23px; padding: 0; position: relative; }
/* unread warnings / problems in the message log (menu button, Messages tab) */
.wh-badge {
  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  background: var(--wh-amber); color: #2e2108; font-size: 11px; font-weight: 800; line-height: 18px; text-align: center;
  pointer-events: none; box-shadow: 0 0 0 2px rgba(17, 23, 19, .85);
}
.wh-badge.bad { background: var(--wh-clay); color: #2b130b; }
.wh-badge.hidden { display: none; }
.wh-tab { position: relative; }
.wh-tab .wh-badge { top: 50%; right: 10px; transform: translateY(-50%); box-shadow: none; }
@media (orientation: portrait) { .wh-tab .wh-badge { top: 3px; right: 4px; transform: none; } }
/* work in progress (e.g. applying a new graphics quality) */
.wh-spin { width: 16px; height: 16px; flex: none; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .18); border-top-color: var(--wh-leaf-2); animation: wh-spin .8s linear infinite; }
@keyframes wh-spin { to { transform: rotate(360deg); } }

@media (orientation: portrait) {
  .wh-ui { --wh-top-h: 104px; }
  .wh-top { display: flex; flex-wrap: wrap; row-gap: 8px; }
  .wh-top-left { order: 1; flex: 1 1 calc(100% - 64px); min-width: 0; }
  .wh-top-menu { order: 2; }
  .wh-top-mid { order: 3; flex: 1 1 auto; justify-self: auto; }
  .wh-top-speed, .wh-slot-speed { order: 4; }
  .wh-stars .wh-star-x { display: none; }
}
/* narrow landscape (≤ 860 px): one star + the number, like portrait (with "138/141" guests and
   six-digit money the full star row pushed the menu button off an 800 px screen) */
@media (orientation: landscape) and (max-width: 860px) {
  .wh-stars .wh-star-x { display: none; }
}
@media (orientation: landscape) and (max-width: 680px) {
  .wh-chip-clock .wh-day { display: none; }
  .wh-top { gap: 6px; }
}
@media (max-width: 480px) {
  .wh-ui .wh-cats { gap: 0; padding: 3px; }
  .wh-cats .wh-cat { width: 46px; min-width: 44px; }
  .wh-cats .wh-cat .wh-btn-label { font-size: 10px; }
  .wh-seg .wh-btn { width: 38px; min-width: 38px; }
}
@media (max-width: 520px) {
  .wh-chip { padding: 0 11px 0 9px; font-size: 14px; gap: 6px; }
  .wh-ui .wh-cf-title { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.2; font-size: 13.5px; }
  .wh-ui .wh-cf-text { padding: 0 4px 0 6px; }
}

/* ------------------------------------------------------------ toasts */
.wh-toasts {
  position: absolute; top: calc(var(--wh-gt) + var(--wh-top-h) + 4px); left: 50%; transform: translateX(-50%);
  width: min(460px, 86vw); display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; z-index: 30;
}
.wh-toast {
  pointer-events: auto; display: flex; align-items: center; gap: 10px; min-height: 44px; max-width: 100%;
  padding: 9px 14px 9px 11px; border-radius: 14px; font-size: 14px; cursor: pointer;
  animation: wh-toast-in .32s cubic-bezier(.2, .9, .3, 1.2) both;
}
.wh-toast.out { animation: wh-toast-out .28s ease both; }
.wh-toast .wh-ico { width: 20px; height: 20px; }
.wh-toast.info .wh-ico { color: var(--wh-sky); }
.wh-toast.good .wh-ico { color: var(--wh-leaf-2); }
.wh-toast.warn .wh-ico { color: var(--wh-amber); }
.wh-toast.bad .wh-ico { color: var(--wh-clay); }
.wh-toast .wh-toast-go { margin-left: auto; color: var(--wh-faint); }
.wh-toast .wh-toast-go .wh-ico { width: 16px; height: 16px; color: inherit; }
.wh-toast .wh-toast-count { font-size: 11px; font-weight: 700; background: rgba(255,255,255,.12); border-radius: 8px; padding: 1px 6px; }
.wh-toast-status { pointer-events: none; cursor: default; }
.wh-toast-status.hidden { display: none; }
/* (GameUI.layoutToasts keeps the column over the clear part of the view: beside open side sheets, the goal pill and the tour's bubble) */
/* over the zoo menu's title row while it is open (feedback such as Save now), under a confirm dialog */
.wh-ui.menu-open .wh-toasts { z-index: 45; }
@keyframes wh-toast-in { from { opacity: 0; transform: translateY(-12px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes wh-toast-out { to { opacity: 0; transform: translateY(-8px) scale(.97); } }

/* ------------------------------------------------------------ world-anchored labels */
.wh-popups { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 5; }
.wh-popup {
  position: absolute; left: 0; top: 0; font-weight: 800; font-size: 15px; white-space: nowrap; will-change: transform, opacity;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .7), 0 0 10px rgba(0, 0, 0, .35); display: none;
}
.wh-popup.plus { color: #c4ec94; }
.wh-popup.minus { color: #ffab90; }
.wh-costlabel {
  position: absolute; left: 0; top: 0; padding: 6px 11px; border-radius: 12px; font-weight: 700; font-size: 13px; white-space: nowrap;
  pointer-events: none; display: none; z-index: 6; will-change: transform;
}
.wh-costlabel .wh-cl-sub { color: var(--wh-muted); font-weight: 600; margin-left: 6px; }
.wh-costlabel.bad { color: #ffab90; }
/* the pending build waits while a drawer is open (its confirm bar hides too) */
.wh-ui.drawer-open .wh-costlabel { visibility: hidden; }

/* ------------------------------------------------------------ bottom dock */
.wh-bottom {
  position: absolute; left: var(--wh-gl); right: var(--wh-gr); bottom: var(--wh-gb);
  display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; z-index: 10;
  transition: left .3s cubic-bezier(.2,.9,.3,1), right .3s cubic-bezier(.2,.9,.3,1);
}
.wh-cats { pointer-events: auto; display: flex; gap: 2px; padding: 4px; border-radius: 22px; max-width: 100%; overflow-x: auto; scrollbar-width: none; touch-action: pan-x; }
.wh-cats::-webkit-scrollbar { display: none; }
.wh-cat {
  flex-direction: column; gap: 3px; width: 66px; min-width: 56px; height: 56px; padding: 0 2px; border-radius: 18px;
  color: rgba(243, 238, 226, 0.78); font-size: 11px;
}
.wh-cat .wh-btn-label { font-weight: 600; font-size: 11px; letter-spacing: .01em; line-height: 1; }
.wh-cat .wh-ico { width: 23px; height: 23px; }
.wh-cat.on { background: rgba(151, 196, 108, 0.20); color: var(--wh-leaf-2); box-shadow: inset 0 0 0 1px rgba(151, 196, 108, .45); }
.wh-cat-sep { width: 1px; align-self: stretch; margin: 10px 3px; background: var(--wh-line); flex: none; }
.wh-cat.sel.on { background: rgba(255, 255, 255, .10); color: var(--wh-text); box-shadow: inset 0 0 0 1px var(--wh-line-2); }

.wh-drawer {
  pointer-events: auto; width: min(100%, 1000px); border-radius: 20px; overflow: hidden; overflow: clip;
  transform-origin: 50% 100%; animation: wh-drawer-in .26s cubic-bezier(.2, .9, .3, 1) both;
}
.wh-drawer.hidden { display: none; }
@keyframes wh-drawer-in { from { transform: translateY(16px) scale(.98); opacity: 0; } to { transform: none; opacity: 1; } }
.wh-drawer-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 0 14px; height: 40px; }
.wh-drawer-title { font-weight: 700; font-size: 14px; letter-spacing: .02em; }
.wh-drawer-sub { color: var(--wh-muted); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh-drawer-head .wh-btn { min-height: 44px; height: 44px; width: 44px; min-width: 44px; border-radius: 22px; margin: -2px -2px -2px 0; }
.wh-drawer-head .wh-btn .wh-ico { width: 18px; height: 18px; }
.wh-row {
  position: relative; /* offsetParent of the cards, so card.offsetLeft is row-relative */
  display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden; padding: 6px 12px 12px; scrollbar-width: none;
  overscroll-behavior: contain; touch-action: pan-x; scroll-snap-type: x proximity;
  scroll-padding-inline: 12px; /* = side padding: snapped items keep the gap, and the start snaps to 0 */
}
.wh-row::-webkit-scrollbar { display: none; }
.wh-sec {
  flex: none; writing-mode: vertical-rl; transform: rotate(180deg); text-transform: uppercase; letter-spacing: .14em;
  font-size: 10.5px; font-weight: 700; color: var(--wh-faint); text-align: center; padding: 0 2px; border-left: 1px solid var(--wh-line);
  margin-left: 2px; scroll-margin-left: 2px; scroll-snap-align: start; /* else the row snaps past the first section label */
}
.wh-card {
  flex: none; width: 92px; padding: 6px 5px 7px; border-radius: 14px; display: flex; flex-direction: column; align-items: center; gap: 3px;
  background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.04); cursor: pointer; scroll-snap-align: start;
  transition: background-color .16s, border-color .16s, transform .12s; pointer-events: auto;
}
.wh-card:active { transform: scale(.95); }
.wh-card.on { background: rgba(151, 196, 108, 0.16); border-color: rgba(151, 196, 108, .6); }
.wh-card.cant .wh-card-price { color: #ff9c80; }
.wh-thumb {
  width: 76px; height: 64px; border-radius: 11px; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(120% 90% at 50% 30%, rgba(255, 250, 235, 0.14), rgba(255, 250, 235, 0.02) 70%);
}
.wh-thumb img { width: 100%; height: 100%; object-fit: contain; display: block; filter: drop-shadow(0 3px 4px rgba(0,0,0,.35)); animation: wh-fade .35s ease both; }
.wh-thumb img.swatch { object-fit: cover; filter: none; border-radius: 9px; }
.wh-thumb .wh-ico { width: 30px; height: 30px; color: var(--wh-faint); }
.wh-thumb-biome { position: absolute; left: 4px; top: 4px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 1px 5px; border-radius: 6px; background: rgba(0,0,0,.45); color: var(--wh-sand); }
.wh-fstats {
  position: absolute; left: 2px; right: 2px; bottom: 2px; display: flex; align-items: center; justify-content: space-between; gap: 2px;
  padding: 2px; border-radius: 7px; background: rgba(0,0,0,.55); font-size: 10.5px; font-weight: 700; line-height: 1; color: var(--wh-sand);
}
.wh-fstats .wh-ico { width: 10px; height: 10px; flex: none; margin-right: 1px; }
.wh-fbars, .wh-fview { display: inline-flex; align-items: flex-end; gap: 1px; white-space: nowrap; }
.wh-fview { align-items: center; }
.wh-fview.poor { color: #f2cd7c; }
.wh-fbars i { width: 2.5px; border-radius: 1px; background: rgba(255,255,255,.22); }
.wh-fbars i:nth-of-type(1) { height: 4px; } .wh-fbars i:nth-of-type(2) { height: 6px; } .wh-fbars i:nth-of-type(3) { height: 8px; } .wh-fbars i:nth-of-type(4) { height: 10px; }
.wh-fbars i.on { background: var(--wh-leaf-2); }
.wh-card-name { font-size: 11.5px; font-weight: 600; text-align: center; line-height: 1.15; height: 2.3em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.wh-card-price { font-size: 11.5px; font-weight: 700; color: var(--wh-sand); }
.wh-card.wide { width: 148px; }
.wh-card.wide .wh-thumb { width: 132px; }
.wh-card.wide .wh-card-name { height: auto; -webkit-line-clamp: 1; }
.wh-card-desc { font-size: 11px; line-height: 1.25; color: var(--wh-muted); text-align: center; height: 2.5em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; padding: 0 2px; }
@keyframes wh-fade { from { opacity: 0; } to { opacity: 1; } }

.wh-actions { display: flex; flex-wrap: wrap-reverse; justify-content: center; align-items: center; gap: 8px; max-width: 100%; pointer-events: none; }
.wh-actions:empty { display: none; }
.wh-toolbar {
  pointer-events: auto; display: flex; align-items: center; gap: 6px; padding: 5px 5px 5px 6px; border-radius: 22px; max-width: 100%;
  transition: transform .22s ease, opacity .2s ease;
}
.wh-toolbar { animation: wh-rise .22s ease both; }
.wh-toolbar.hidden { display: none; }
@keyframes wh-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.wh-tb-thumb { width: 40px; height: 40px; border-radius: 12px; overflow: hidden; flex: none; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.06); }
.wh-tb-thumb img { width: 100%; height: 100%; object-fit: contain; }
.wh-tb-thumb img.swatch { object-fit: cover; }
.wh-tb-thumb .wh-ico { color: var(--wh-leaf-2); }
.wh-tb-text { display: flex; flex-direction: column; min-width: 0; padding: 0 4px; max-width: 340px; }
.wh-tb-name { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-tb-hint { font-size: 12px; color: var(--wh-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-tb-opts { display: flex; gap: 4px; }
.wh-tb-opts .wh-btn { width: 44px; padding: 0; border-radius: 15px; }
.wh-tb-opts .wh-btn.on { background: rgba(151, 196, 108, .22); color: var(--wh-leaf-2); }
.wh-tb-opts .wh-btn .wh-brush-n { font-size: 11px; font-weight: 700; margin-left: -2px; }
.wh-tb-done { border-radius: 16px; }

.wh-confirm {
  pointer-events: auto; display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 24px; max-width: 100%;
  transition: transform .24s cubic-bezier(.2,.9,.3,1.2), opacity .2s ease;
}
.wh-confirm { animation: wh-pop .24s cubic-bezier(.2,.9,.3,1.2) both; }
.wh-confirm.hidden { display: none; }
.wh-confirm.shake { animation: wh-shake .42s ease; }
.wh-cf-text { display: flex; flex-direction: column; padding: 0 8px 0 10px; min-width: 0; max-width: 360px; }
.wh-cf-title { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-cf-sub { font-size: 12px; color: var(--wh-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-cf-sub.bad { color: #ffab90; }
.wh-cf-sub.warn { color: var(--wh-amber); }
/* warnings are whole sentences: two lines rather than an ellipsis */
.wh-cf-sub.bad, .wh-cf-sub.warn { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.25; }
.wh-cf-ok { height: 46px; padding: 0 18px 0 14px; border-radius: 18px; font-size: 15px; flex: none; }
.wh-cf-ok.remove { background: linear-gradient(180deg, #f0a587, #d27352); color: #2b130b; box-shadow: 0 4px 14px rgba(210, 115, 82, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.3); }
/* allowed but not advised (e.g. a fence that won't form a habitat): amber, so it never reads as the usual go-ahead */
.wh-cf-ok.risky { background: linear-gradient(180deg, #f0cf86, #d6a646); color: #2e2108; box-shadow: 0 4px 14px rgba(214, 166, 70, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3); }
.wh-cf-no { height: 46px; width: 46px; border-radius: 18px; padding: 0; flex: none; }
.wh-cf-text { flex: 1 1 auto; }
.wh-tb-thumb, .wh-tb-opts, .wh-tb-done { flex: none; }
.wh-tb-text { flex: 1 1 auto; }
@keyframes wh-shake { 0%,100% { transform: none; } 20% { transform: translateX(-8px); } 40% { transform: translateX(7px); } 60% { transform: translateX(-5px); } 80% { transform: translateX(3px); } }
/* first few times in build mode: how the camera moves now that one finger builds */
.wh-tb-tip { display: flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600; color: var(--wh-leaf-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-tb-tip.hidden { display: none; }
/* with a build drawer open the tool bar sits above it: keep it one line shorter so it clears the top bar on short screens */
.wh-ui.drawer-open .wh-tb-tip { display: none; }
.wh-tb-tip .wh-ico { width: 14px; height: 14px; flex: none; }

/* ------------------------------------------------------------ next-goal pill (also the tutorial's step) */
.wh-goal {
  position: absolute; top: calc(var(--wh-gt) + var(--wh-top-h) + 6px); left: var(--wh-gl); z-index: 8;
  pointer-events: auto; display: flex; align-items: center; gap: 9px; min-height: 42px; padding: 4px 12px 4px 10px; border-radius: 16px;
  max-width: min(400px, 46vw); font-size: 12.5px; cursor: pointer; transition: opacity .25s ease, transform .12s ease;
}
.wh-goal::after { content: ""; position: absolute; inset: -2px 0; } /* 46 px tall touch target */
.wh-goal:active { transform: scale(.97); }
/* hidden, and under the species card that opens in the same corner */
/* also while a build drawer is open: the tool bar then sits where the pill is */
.wh-goal.hidden, .wh-ui.card-open .wh-goal, .wh-ui.drawer-open .wh-goal { opacity: 0; visibility: hidden; pointer-events: none; }
/* a UI extension can put the pill away (e.g. while the tutorial's bubble speaks for it) */
.wh-ui.wh-pill-off .wh-goal { opacity: 0; visibility: hidden; pointer-events: none; }
/* left: the trophy over "NEXT"; right: the goal, then its progress bar, "141 / 150" and the reward */
.wh-goal-k { display: flex; flex-direction: column; align-items: center; gap: 1px; flex: none; color: var(--wh-sand); font-size: 10.5px; font-weight: 750; text-transform: uppercase; letter-spacing: .08em; line-height: 1.1; }
.wh-goal-k .wh-ico { width: 16px; height: 16px; }
.wh-goal-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.wh-goal-t { font-weight: 600; line-height: 1.25; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh-goal-sub { display: flex; align-items: center; gap: 7px; font-size: 11.5px; line-height: 1.2; color: var(--wh-muted); white-space: nowrap; }
.wh-goal-bar { flex: none; width: 52px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.14); overflow: hidden; }
.wh-goal-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--wh-leaf); transition: width .5s ease; }
.wh-goal-bar.hidden, .wh-goal-p:empty { display: none; }
.wh-goal-r { flex: none; margin-left: auto; color: var(--wh-leaf-2); font-weight: 700; }
.wh-goal-r:empty { display: none; }
.wh-goal-p:empty + .wh-goal-r { margin-left: 0; } /* a one-step goal: just the reward, under the goal */
.wh-goal.fresh { animation: wh-goal-glow 1.6s ease; }
/* the tutorial's step: a leaf over "STEP", the chapter, "4 / 12" and its bar */
.wh-goal.step { border-color: rgba(151, 196, 108, .55); }
.wh-goal.step .wh-goal-k { color: var(--wh-leaf-2); }
@keyframes wh-goal-glow { 25% { box-shadow: 0 0 0 3px rgba(151, 196, 108, .6), 0 10px 28px rgba(0, 0, 0, .28); } }

/* ------------------------------------------------------------ side sheets (info panels) */
.wh-sheet {
  position: absolute; pointer-events: auto; display: flex; flex-direction: column; border-radius: 20px; overflow: hidden; z-index: 12;
  right: var(--wh-gr); top: calc(var(--wh-gt) + var(--wh-top-h) + 6px); bottom: calc(var(--wh-gb) + var(--wh-cats-h) + 16px);
  width: min(340px, 40vw); transition: transform .3s cubic-bezier(.2,.9,.3,1), opacity .22s ease, visibility 0s;
}
/* visibility (after the slide-out) also hides the buttons, which set pointer-events: auto themselves */
.wh-sheet.hidden {
  transform: translateX(calc(100% + 24px)); opacity: 0; pointer-events: none; visibility: hidden;
  transition: transform .3s cubic-bezier(.2,.9,.3,1), opacity .22s ease, visibility 0s linear .3s;
}
.wh-sheet.left { right: auto; left: var(--wh-gl); width: min(310px, 36vw); }
.wh-sheet.left.hidden { transform: translateX(calc(-100% - 24px)); }
@media (orientation: landscape) {
  .wh-sheet { bottom: var(--wh-gb); }
  .wh-ui.sheet-open .wh-bottom { right: calc(var(--wh-gr) + min(340px, 40vw) + 10px); }
  .wh-ui.sheet-open .wh-cat { width: 54px; min-width: 50px; }
  .wh-ui.card-open .wh-bottom { left: calc(var(--wh-gl) + min(310px, 36vw) + 10px); }
  .wh-ui.card-open .wh-cat { width: 54px; min-width: 50px; }
}
@media (orientation: portrait) {
  .wh-sheet { left: var(--wh-gl); right: var(--wh-gr); width: auto; top: auto; max-height: 56vh; bottom: calc(var(--wh-gb) + var(--wh-cats-h) + 14px); }
  .wh-sheet.hidden { transform: translateY(calc(100% + 120px)); }
  .wh-sheet.left { left: var(--wh-gl); width: auto; top: calc(var(--wh-gt) + var(--wh-top-h) + 6px); bottom: auto; max-height: 38vh; }
  .wh-sheet.left.hidden { transform: translateY(calc(-100% - 140px)); }
}
.wh-sheet-head { display: flex; align-items: center; gap: 10px; padding: 12px 8px 10px 14px; border-bottom: 1px solid var(--wh-line); flex: none; }
.wh-sheet-badge { width: 42px; height: 42px; border-radius: 13px; flex: none; display: flex; align-items: center; justify-content: center; background: rgba(151,196,108,.16); color: var(--wh-leaf-2); overflow: hidden; }
.wh-sheet-badge img { width: 100%; height: 100%; object-fit: contain; }
.wh-sheet-titles { min-width: 0; flex: 1; }
.wh-sheet-title { font-size: 17px; font-weight: 750; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: .005em; }
.wh-sheet-sub { font-size: 12.5px; color: var(--wh-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-sheet-sub i { font-style: italic; }
.wh-sheet-body { overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 10px 14px 14px; flex: 1; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
.wh-sheet-foot { display: flex; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--wh-line); flex: none; }
.wh-sheet-foot .wh-btn { flex: 1; }
.wh-sect { margin: 4px 0 12px; }
.wh-sect-h { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: var(--wh-faint); margin: 12px 0 7px; display: flex; align-items: center; gap: 8px; }
.wh-sect-h::after { content: ""; flex: 1; height: 1px; background: var(--wh-line); }
.wh-kv { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.wh-kv-item { background: rgba(255,255,255,.045); border-radius: 11px; padding: 7px 10px; min-width: 0; }
.wh-kv-k { font-size: 11px; color: var(--wh-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-kv-v { font-size: 14.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-kv-v.wrap { white-space: normal; font-size: 13.5px; line-height: 1.3; }
.wh-kv-v.bad { color: #ffab90; } .wh-kv-v.good { color: var(--wh-leaf-2); } .wh-kv-v.warn { color: var(--wh-amber); }
.wh-meters { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 14px; }
.wh-meters.one { grid-template-columns: 1fr; }
.wh-meter-head { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 4px; }
.wh-meter-ico .wh-ico { width: 14px; height: 14px; color: var(--wh-muted); }
.wh-meter-label { color: var(--wh-muted); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-meter-val { font-weight: 700; font-size: 12px; }
.wh-meter-track { height: 6px; border-radius: 3px; background: rgba(255,255,255,.08); overflow: hidden; }
.wh-meter.big .wh-meter-track { height: 9px; border-radius: 5px; }
.wh-meter.big .wh-meter-head { font-size: 13px; }
.wh-meter-fill { height: 100%; width: 100%; transform-origin: 0 50%; transform: scaleX(0); transition: transform .45s ease, background-color .3s; border-radius: inherit; }
.lvl-bad { background: #e57c5e; } .lvl-warn { background: #e8b44f; } .lvl-ok { background: #bfd06c; } .lvl-good { background: #8fc76a; }
.wh-list { display: flex; flex-direction: column; gap: 6px; }
.wh-li { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 10px; border-radius: 12px; background: rgba(255,255,255,.045); }
.wh-li.tap { cursor: pointer; }
.wh-li.tap:active { background: rgba(255,255,255,.09); }
.wh-li .wh-ico { width: 18px; height: 18px; color: var(--wh-muted); }
.wh-li-main { flex: 1; min-width: 0; }
.wh-li-t { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-li-s { font-size: 12px; color: var(--wh-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-li-r { font-weight: 700; font-size: 13px; }
.wh-msg .wh-msg-t { font-weight: 600; font-size: 13.5px; line-height: 1.3; }
.wh-msg.info > .wh-ico { color: var(--wh-sky); }
.wh-msg.good > .wh-ico { color: var(--wh-leaf-2); }
.wh-msg.warn > .wh-ico { color: var(--wh-amber); }
.wh-msg.bad > .wh-ico { color: var(--wh-clay); }
.wh-li.wh-msg > .wh-msg-go { width: 16px; height: 16px; color: var(--wh-faint); }
.wh-thought { font-size: 13px; padding: 7px 10px; border-radius: 12px 12px 12px 4px; background: rgba(255,255,255,.06); color: rgba(243,238,226,.86); }
.wh-thought:first-child { background: rgba(151,196,108,.14); color: var(--wh-text); }
.wh-note { font-size: 12.5px; color: var(--wh-muted); line-height: 1.45; }
.wh-only-mouse { display: none; }
@media (hover: hover) and (pointer: fine) { .wh-only-mouse { display: inline; } .wh-only-touch { display: none; } }
.wh-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.wh-tag { font-size: 11.5px; padding: 3px 8px; border-radius: 9px; background: rgba(255,255,255,.07); display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.wh-tag i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
.wh-tag.bad { background: rgba(232,132,102,.16); color: #ffb39b; }
.wh-tag.good { background: rgba(151,196,108,.16); color: var(--wh-leaf-2); }
.wh-tag.warn { background: rgba(235,184,84,.15); color: #f2cd7c; }
.wh-comp { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: rgba(255,255,255,.06); margin-bottom: 7px; }
.wh-comp > span { height: 100%; transition: width .4s ease; }
.wh-issues { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.wh-issues li { font-size: 12.5px; color: #f2cd7c; display: flex; gap: 6px; align-items: flex-start; }
.wh-issues li::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; margin-top: 6px; flex: none; }
.wh-issues li.ok { color: var(--wh-leaf-2); }
.wh-suit { padding: 10px 12px; border-radius: 14px; background: rgba(255,255,255,.045); margin-bottom: 8px; }
.wh-suit-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.wh-suit-name { font-weight: 700; flex: 1; }
.wh-score { font-weight: 800; font-size: 15px; padding: 2px 9px; border-radius: 10px; }
.wh-score.lvl-bad { background: rgba(229,124,94,.22); color: #ffb39b; }
.wh-score.lvl-warn { background: rgba(232,180,79,.2); color: #f4cf80; }
.wh-score.lvl-ok { background: rgba(191,208,108,.18); color: #d8e59a; }
.wh-score.lvl-good { background: rgba(143,199,106,.2); color: #bfe69c; }
.wh-input {
  appearance: none; font: inherit; color: var(--wh-text); background: rgba(255,255,255,.07); border: 1px solid var(--wh-line-2);
  border-radius: 10px; height: 38px; padding: 0 10px; width: 100%; outline: none; -webkit-user-select: text; user-select: text; pointer-events: auto;
}
.wh-input:focus { border-color: var(--wh-leaf); }
.wh-rename { display: flex; gap: 6px; align-items: center; }
.wh-sheet-title.edit { cursor: pointer; display: flex; align-items: center; gap: 6px; }
.wh-sheet-title.edit .wh-ico { width: 15px; height: 15px; color: var(--wh-faint); }

/* ------------------------------------------------------------ modal (zoo panel) */
.wh-modal-back {
  position: absolute; inset: 0; background: rgba(6, 10, 8, 0.42); pointer-events: auto; display: flex; align-items: center; justify-content: center;
  z-index: 40; transition: opacity .22s ease, visibility 0s; padding: var(--wh-gt) var(--wh-gr) var(--wh-gb) var(--wh-gl);
}
/* pointer-events alone is not enough: .wh-btn / .wh-slider / .wh-segtext re-enable them, so a closed
   menu would keep catching taps on the map. visibility (switched after the fade) removes every control. */
.wh-modal-back.hidden { opacity: 0; pointer-events: none; visibility: hidden; transition: opacity .22s ease, visibility 0s linear .22s; }
.wh-modal {
  width: min(900px, 100%); height: min(560px, 100%); border-radius: 22px; display: grid; grid-template-columns: 172px 1fr; overflow: hidden;
  transition: transform .28s cubic-bezier(.2,.9,.3,1.1);
}
.wh-modal-back.hidden .wh-modal { transform: scale(.96) translateY(10px); }
.wh-tabs { display: flex; flex-direction: column; gap: 4px; padding: 14px 10px; border-right: 1px solid var(--wh-line); background: rgba(0,0,0,.12); }
.wh-tabs-title { display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 15px; padding: 2px 6px 12px; letter-spacing: .01em; }
.wh-tabs-title svg.logo { width: 28px; height: 28px; }
.wh-tab { justify-content: flex-start; padding: 0 12px; height: 46px; color: var(--wh-muted); border-radius: 13px; }
.wh-tab.on { background: rgba(151,196,108,.16); color: var(--wh-leaf-2); }
.wh-tab .wh-ico { width: 20px; height: 20px; }
.wh-tabs-spacer { flex: 1; }
.wh-modal-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.wh-modal-head { display: flex; align-items: center; padding: 12px 10px 8px 20px; flex: none; }
.wh-modal-head h2 { margin: 0; font-size: 19px; font-weight: 800; flex: 1; letter-spacing: .005em; }
.wh-modal-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 2px 20px 20px; min-height: 0; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
@media (orientation: portrait) {
  .wh-modal { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: 100%; }
  .wh-tabs { flex-direction: row; border-right: 0; border-bottom: 1px solid var(--wh-line); padding: 8px; overflow-x: auto; scrollbar-width: none; }
  .wh-tabs-title, .wh-tabs-spacer { display: none; }
  .wh-tab { flex: 1; justify-content: center; padding: 0 6px; min-width: 64px; flex-direction: column; gap: 2px; height: 54px; font-size: 11px; }
  .wh-modal-head { padding: 10px 8px 4px 16px; }
  .wh-modal-body { padding: 2px 14px 16px; }
}
@media (orientation: landscape) and (max-height: 460px) {
  .wh-modal { grid-template-columns: 150px 1fr; }
  .wh-tabs { padding: 10px 8px; }
  .wh-tab { height: 44px; }
  .wh-tabs-title { padding-bottom: 6px; }
}
.wh-stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.wh-stat { background: rgba(255,255,255,.045); border-radius: 14px; padding: 10px 12px; }
.wh-stat-k { font-size: 11.5px; color: var(--wh-muted); display: flex; align-items: center; gap: 6px; }
.wh-stat-k .wh-ico { width: 15px; height: 15px; }
.wh-stat-v { font-size: 20px; font-weight: 800; margin-top: 2px; letter-spacing: -.005em; }
.wh-stat-v.bad { color: #ffab90; } .wh-stat-v.good { color: var(--wh-leaf-2); } .wh-stat-v.warn { color: var(--wh-amber); }
.wh-stat-s { font-size: 11.5px; color: var(--wh-faint); }
.wh-chart { width: 100%; height: 150px; display: block; }
.wh-chart text { fill: rgba(243,238,226,.55); font-size: 10.5px; font-family: inherit; }
.wh-legend { display: flex; gap: 14px; font-size: 12px; color: var(--wh-muted); margin: 2px 0 6px; flex-wrap: wrap; }
.wh-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.wh-ledger { width: 100%; border-collapse: collapse; font-size: 13px; }
.wh-ledger td { padding: 6px 4px; border-bottom: 1px solid var(--wh-line); }
.wh-ledger td:last-child { text-align: right; font-weight: 650; }
.wh-ledger tr.total td { border-bottom: 0; font-weight: 800; font-size: 14px; }
.wh-ledger tr.total:not(:last-child) td { border-bottom: 1px solid var(--wh-line-2); } /* running profit, before the one-offs */
.wh-ledger-note { font-size: 11px; color: var(--wh-faint); white-space: nowrap; }
.wh-chart-tip { font-size: 11.5px; color: var(--wh-muted); min-height: 2.6em; margin-top: 2px; }
.wh-ledger .pos { color: var(--wh-leaf-2); } .wh-ledger .neg { color: #ffab90; }
.wh-two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 640px) { .wh-two { grid-template-columns: 1fr; } }
.wh-slider-row { display: flex; align-items: center; gap: 12px; }
.wh-slider { flex: 1; -webkit-appearance: none; appearance: none; height: 44px; background: transparent; pointer-events: auto; touch-action: pan-x; }
.wh-slider::-webkit-slider-runnable-track { height: 8px; border-radius: 4px; background: linear-gradient(90deg, var(--wh-leaf) var(--p, 50%), rgba(255,255,255,.12) var(--p, 50%)); }
.wh-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 28px; height: 28px; margin-top: -10px; border-radius: 50%; background: #f5efe0; box-shadow: 0 2px 8px rgba(0,0,0,.4); border: 3px solid var(--wh-leaf); }
.wh-slider::-moz-range-track { height: 8px; border-radius: 4px; background: rgba(255,255,255,.12); }
.wh-slider::-moz-range-progress { height: 8px; border-radius: 4px; background: var(--wh-leaf); }
.wh-slider::-moz-range-thumb { width: 24px; height: 24px; border-radius: 50%; background: #f5efe0; border: 3px solid var(--wh-leaf); }
.wh-slider-val { font-size: 20px; font-weight: 800; min-width: 64px; text-align: right; }
.wh-obj { display: flex; gap: 12px; align-items: center; padding: 10px 12px; border-radius: 14px; background: rgba(255,255,255,.045); margin-bottom: 7px; }
.wh-obj-check { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--wh-line-2); flex: none; display: flex; align-items: center; justify-content: center; }
.wh-obj.done .wh-obj-check { background: var(--wh-leaf); border-color: var(--wh-leaf); color: #142010; }
.wh-obj.done .wh-obj-text { color: var(--wh-muted); text-decoration: line-through; text-decoration-color: rgba(243,238,226,.35); }
.wh-obj-check .wh-ico { width: 16px; height: 16px; stroke-width: 2.6; }
.wh-obj-text { flex: 1; min-width: 0; font-weight: 600; }
/* how far along an open goal is: a thin bar and "141 / 150" under its text */
.wh-obj-prog { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 11.5px; font-weight: 600; color: var(--wh-muted); }
.wh-obj-bar { flex: 0 1 140px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.1); overflow: hidden; }
.wh-obj-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--wh-leaf); }
.wh-obj-reward { font-weight: 800; color: var(--wh-sand); font-size: 13px; }
.wh-progress { height: 10px; border-radius: 5px; background: rgba(255,255,255,.08); overflow: hidden; margin: 6px 0 14px; }
.wh-progress > div { height: 100%; background: linear-gradient(90deg, var(--wh-leaf-deep), var(--wh-leaf)); border-radius: inherit; transition: width .5s ease; }
.wh-setting { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--wh-line); min-height: 60px; }
.wh-setting-t { flex: 1; min-width: 0; }
.wh-setting-t b { display: block; font-size: 14.5px; }
.wh-setting-t span { font-size: 12px; color: var(--wh-muted); }
.wh-setting-t .wh-applying { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--wh-leaf-2); font-weight: 600; }
.wh-setting-t .wh-applying.hidden { display: none; }
.wh-applying .wh-spin { width: 13px; height: 13px; }
.wh-segtext { display: inline-flex; padding: 3px; border-radius: 14px; background: rgba(255,255,255,.06); border: 1px solid var(--wh-line); pointer-events: auto; }
.wh-segtext .wh-btn { min-height: 40px; height: 40px; padding: 0 14px; border-radius: 11px; color: var(--wh-muted); font-weight: 650; position: relative; }
.wh-segtext .wh-btn::after { content: ""; position: absolute; inset: -3px 0; }
.wh-segtext .wh-btn.on { background: var(--wh-leaf); color: #142010; }
.wh-switch { width: 56px; height: 34px; border-radius: 17px; background: rgba(255,255,255,.12); position: relative; padding: 0; min-width: 56px; min-height: 34px; }
.wh-switch::before { content: ""; position: absolute; inset: -6px -4px; }
.wh-switch::after { content: ""; position: absolute; left: 4px; top: 4px; width: 26px; height: 26px; border-radius: 50%; background: #f5efe0; transition: transform .2s ease; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.wh-switch.on { background: var(--wh-leaf); }
.wh-switch.on::after { transform: translateX(22px); }

/* ------------------------------------------------------------ dialogs */
.wh-dialog-back { position: absolute; inset: 0; z-index: 60; background: rgba(6,10,8,.5); display: flex; align-items: center; justify-content: center; pointer-events: auto; animation: wh-fade .2s ease both; padding: 16px; }
.wh-dialog { width: min(380px, 100%); border-radius: 20px; padding: 18px 18px 14px; animation: wh-pop .26s cubic-bezier(.2,.9,.3,1.2) both; }
.wh-dialog h3 { margin: 0 0 6px; font-size: 17px; font-weight: 800; }
.wh-dialog p { margin: 0 0 16px; color: var(--wh-muted); font-size: 13.5px; line-height: 1.45; }
.wh-dialog-btns { display: flex; gap: 8px; justify-content: flex-end; }
.wh-dialog-btns .wh-btn { flex: 1; }
@keyframes wh-pop { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: none; } }

/* ------------------------------------------------------------ celebration */
/* taps go straight through the goal card to the map: it only announces */
.wh-cele-card { pointer-events: none; margin-bottom: 4px; position: relative; display: flex; align-items: center; gap: 12px; padding: 10px 18px 10px 10px; border-radius: 18px; min-width: min(320px, 100%); max-width: 100%; animation: wh-cele-in .55s cubic-bezier(.2,.9,.3,1.3) both; overflow: visible; }
.wh-cele-card.out { animation: wh-toast-out .4s ease both; }
.wh-cele-badge { width: 44px; height: 44px; border-radius: 14px; display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg, #f2cf74, #c99636); color: #3a2a08; flex: none; box-shadow: 0 6px 18px rgba(220,170,70,.4); }
.wh-cele-badge .wh-ico { width: 25px; height: 25px; }
.wh-cele-k { font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #f2cf74; }
.wh-cele-t { font-weight: 700; font-size: 15px; margin: 1px 0; }
.wh-cele-r { font-weight: 800; color: var(--wh-leaf-2); }
.wh-confetti { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; }
.wh-confetti i { position: absolute; width: 7px; height: 11px; border-radius: 2px; opacity: 0; animation: wh-confetti 1.6s cubic-bezier(.15,.7,.4,1) forwards; }
@keyframes wh-cele-in { from { opacity: 0; transform: translateY(-20px) scale(.85); } to { opacity: 1; transform: none; } }
@keyframes wh-confetti {
  0% { opacity: 1; transform: translate(0, 0) rotate(0deg); }
  100% { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); }
}

/* ------------------------------------------------------------ species hint card */
.wh-hint-sp { display: flex; gap: 10px; align-items: flex-start; }
.wh-biome { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--wh-sand); }
.wh-suit-cta { margin-top: 8px; font-size: 12.5px; color: var(--wh-muted); display: flex; gap: 8px; align-items: center; padding: 9px 10px; border-radius: 12px; background: rgba(151,196,108,.10); border: 1px dashed rgba(151,196,108,.35); }
.wh-suit-cta .wh-ico { width: 18px; height: 18px; color: var(--wh-leaf-2); }

/* ------------------------------------------------------------ full-screen loading / menu */
.wh-screen { position: fixed; inset: 0; z-index: 100; pointer-events: auto; overflow: hidden; display: flex; align-items: center; justify-content: center; touch-action: none; transition: opacity .6s ease; }
.wh-screen.fade { opacity: 0; pointer-events: none; }
.wh-screen.fade * { pointer-events: none; } /* buttons re-enable pointer events; a fading screen must not take taps */
.wh-load { background: radial-gradient(120% 90% at 50% 20%, #1f3324 0%, #0f1b13 55%, #08100b 100%); }
.wh-load-bg { position: absolute; inset: -10%; opacity: .55; }
.wh-load-col { position: relative; display: flex; flex-direction: column; align-items: center; gap: 0; width: min(460px, 84vw); padding: var(--wh-gt) 0 var(--wh-gb); }
.wh-logo { width: 116px; height: 116px; filter: drop-shadow(0 10px 30px rgba(0,0,0,.45)); }
.wh-load .wh-logo { animation: wh-breathe 4s ease-in-out infinite; }
@keyframes wh-breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.03); } }
.wh-title { font-family: "Palatino Linotype", Palatino, "Book Antiqua", "Noto Serif", Georgia, serif; font-weight: 600; font-size: 40px; letter-spacing: .02em; margin: 14px 0 0; line-height: 1.05; text-align: center; color: #f6efdc; text-shadow: 0 2px 18px rgba(0,0,0,.35); }
.wh-title em { font-style: normal; color: var(--wh-sand); }
.wh-tagline { font-size: 12px; letter-spacing: .32em; text-transform: uppercase; color: rgba(228,208,160,.72); margin-top: 8px; text-align: center; }
.wh-bar { width: 100%; height: 8px; border-radius: 4px; background: rgba(255,255,255,.08); overflow: hidden; margin-top: 34px; box-shadow: inset 0 1px 2px rgba(0,0,0,.35); }
.wh-bar-fill { height: 100%; width: 100%; transform-origin: 0 50%; transform: scaleX(0); border-radius: inherit; transition: transform .35s ease; background: linear-gradient(90deg, #5f8f3e, #97c46c 60%, #e4d0a0); position: relative; overflow: hidden; }
.wh-bar-fill::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent); transform: translateX(-100%); animation: wh-shimmer 1.6s ease-in-out infinite; }
@keyframes wh-shimmer { to { transform: translateX(100%); } }
.wh-load-row { display: flex; justify-content: space-between; width: 100%; margin-top: 10px; font-size: 13px; color: var(--wh-muted); }
.wh-load-pct { font-weight: 700; color: var(--wh-text); }
.wh-tip { position: absolute; bottom: calc(var(--wh-gb) + 18px); left: 50%; transform: translateX(-50%); width: min(560px, 88vw); text-align: center; font-size: 13px; color: rgba(243,238,226,.7); transition: opacity .5s ease; display: flex; gap: 8px; justify-content: center; align-items: flex-start; }
.wh-tip .wh-ico { width: 18px; height: 18px; color: var(--wh-leaf); flex: none; margin-top: 1px; }
.wh-tip.fade { opacity: 0; }
@media (max-height: 460px) {
  .wh-logo { width: 84px; height: 84px; }
  .wh-title { font-size: 32px; margin-top: 8px; }
  .wh-bar { margin-top: 22px; }
}

.wh-menu { background: #0c140f; }
.wh-menu-bg { position: absolute; inset: -6%; width: 112%; height: 112%; filter: blur(3px) saturate(1.1) brightness(1.04); transform: scale(1.02); animation: wh-drift 40s ease-in-out infinite alternate; }
@keyframes wh-drift { from { transform: scale(1.02) translateX(-1%); } to { transform: scale(1.06) translateX(1%); } }
.wh-menu-shade { position: absolute; inset: 0; background: radial-gradient(100% 90% at 50% 55%, rgba(8,14,10,0), rgba(8,14,10,.55)); }
.wh-menu-card { position: relative; display: flex; flex-direction: column; align-items: center; padding: 26px 28px 20px; border-radius: 26px; width: min(420px, 92vw); max-height: calc(100% - 20px); overflow-y: auto; scrollbar-width: none; }
.wh-menu-card .wh-logo { width: 92px; height: 92px; }
.wh-menu-card .wh-title { font-size: 36px; }
.wh-menu-btns { display: flex; flex-direction: column; gap: 10px; width: 100%; margin-top: 22px; }
.wh-menu-btns .wh-btn { height: 52px; font-size: 16px; border-radius: 16px; width: 100%; }
.wh-menu-q { display: flex; align-items: center; justify-content: space-between; width: 100%; margin-top: 16px; gap: 10px; }
.wh-menu-q > span { font-size: 13px; color: var(--wh-muted); }
.wh-menu-foot { margin-top: 14px; font-size: 11px; color: var(--wh-faint); letter-spacing: .06em; }
.wh-menu-save { font-size: 12px; color: var(--wh-muted); margin-top: -4px; }
@media (orientation: landscape) and (max-height: 480px) {
  .wh-menu-card { flex-direction: row; flex-wrap: wrap; width: min(700px, 94vw); padding: 20px 22px; gap: 0 26px; align-items: center; }
  .wh-menu-brand { flex: 1 1 260px; display: flex; flex-direction: column; align-items: center; }
  .wh-menu-actions { flex: 1 1 280px; }
  .wh-menu-btns { margin-top: 0; }
  .wh-menu-card .wh-logo { width: 76px; height: 76px; }
  .wh-menu-card .wh-title { font-size: 32px; }
}
.wh-menu-brand, .wh-menu-actions { width: 100%; display: flex; flex-direction: column; align-items: center; }

/* ------------------------------------------------------------ compact landscape (last: overrides the base rules above) */
@media (orientation: landscape) and (max-height: 500px) {
  .wh-sheet-head { padding: 9px 8px 8px 12px; }
  .wh-sheet-foot { padding: 8px 10px 10px; }
  .wh-sheet-body { padding: 8px 12px 12px; }
  .wh-sheet-badge { width: 38px; height: 38px; }
}
/* short landscape phones (≤ 430 px tall): win back vertical room for content */
@media (orientation: landscape) and (max-height: 430px) {
  .wh-sheet { top: calc(var(--wh-gt) + var(--wh-top-h) + 2px); }
  .wh-sheet-head { padding: 5px 5px 5px 10px; gap: 8px; }
  .wh-sheet-badge { width: 34px; height: 34px; border-radius: 11px; }
  .wh-sheet-title { font-size: 15.5px; }
  .wh-sheet-sub { font-size: 12px; }
  .wh-sheet-body { padding: 4px 10px 10px; }
  .wh-sheet-foot { padding: 5px 6px 6px; gap: 6px; }
  .wh-sect { margin: 2px 0 8px; }
  .wh-sect-h { margin: 8px 0 5px; }
  .wh-meters { gap: 6px 12px; }
  .wh-meter-head { margin-bottom: 3px; }
  .wh-kv-item { padding: 5px 9px; }
  .wh-drawer-head { height: 36px; padding-top: 4px; }
  .wh-row { padding: 4px 10px 8px; scroll-padding-inline: 10px; }
  .wh-modal-head { padding: 6px 6px 2px 16px; }
  .wh-modal-head h2 { font-size: 17px; }
  .wh-modal-body { padding: 2px 16px 12px; }
  .wh-stat { padding: 7px 10px; border-radius: 12px; }
  .wh-stat-v { font-size: 17px; }
  .wh-stat-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .wh-setting { min-height: 52px; padding: 6px 0; }
  .wh-tabs-title { padding-bottom: 4px; }
}
/* very short landscape phones (≤ 400 px tall, e.g. 800×360): a slimmer dock, drawer cards and tool bar,
   so a tool bar over an open drawer still clears the top HUD. Buttons keep 44 px touch targets. */
@media (orientation: landscape) and (max-height: 400px) {
  .wh-bottom { gap: 6px; }
  .wh-cat { height: 48px; gap: 2px; border-radius: 15px; }
  .wh-cat .wh-ico { width: 21px; height: 21px; }
  .wh-row { padding: 3px 10px 7px; }
  .wh-card { padding: 4px 5px 5px; gap: 2px; }
  .wh-thumb { height: 50px; }
  .wh-card.wide .wh-thumb { height: 42px; }
  .wh-toolbar { padding: 4px 4px 4px 5px; }
  .wh-tb-thumb { width: 36px; height: 36px; border-radius: 10px; }
  .wh-tb-opts .wh-btn, .wh-tb-done { height: 38px; min-height: 38px; position: relative; }
  .wh-tb-opts .wh-btn::after, .wh-tb-done::after { content: ""; position: absolute; inset: -3px 0; }
  .wh-confirm { padding: 4px; }
  .wh-cf-ok, .wh-cf-no { height: 44px; }
  .wh-cf-no { width: 44px; }
}
.wh-avatar { display: block; flex: none; border-radius: 50%; }
@media (prefers-reduced-motion: reduce) {
  .wh-ui *, .wh-screen * { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;

let injected = false;

export function ensureStyles(): void {
  if (injected || document.getElementById('wh-ui-styles')) {
    injected = true;
    return;
  }
  const s = document.createElement('style');
  s.id = 'wh-ui-styles';
  s.textContent = CSS;
  document.head.appendChild(s);
  injected = true;
}
