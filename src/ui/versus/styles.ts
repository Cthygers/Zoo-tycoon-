// Styles of the versus screens (hub, lobby, chip, sheet, countdown, results), injected once.
// They build on the shell's tokens (--wh-*) and classes (.wh-btn, .wh-glass, .wh-screen,
// .wh-confetti); everything here is prefixed wh-vs-. Big tap targets (≥ 52 px) for kids.
import { ensureStyles } from '../styles';

const CSS = `
/* ------------------------------------------------------------ hub screen */
.wh-vs { background: radial-gradient(120% 100% at 50% 0%, #20372a 0%, #102017 55%, #09130d 100%); align-items: stretch; justify-content: stretch; touch-action: pan-y; }
.wh-vs-page { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; padding: var(--wh-gt) var(--wh-gr) var(--wh-gb) var(--wh-gl); gap: 10px; max-width: 980px; margin: 0 auto; }
.wh-vs-head { display: flex; align-items: center; gap: 10px; min-height: 48px; flex: none; }
.wh-vs-head h2 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: .01em; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-vs-back { width: 48px; height: 48px; border-radius: 24px; padding: 0; flex: none; }
.wh-vs-me { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; color: var(--wh-muted); flex: none; }
.wh-vs-av { display: inline-flex; flex: none; border-radius: 50%; overflow: hidden; line-height: 0; }
.wh-vs-av svg { display: block; }
.wh-vs-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; display: flex; flex-direction: column; gap: 10px; padding-bottom: 4px; }
.wh-vs-body::-webkit-scrollbar { display: none; }
.wh-vs-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; flex: none; }
.wh-vs-card { appearance: none; font: inherit; color: inherit; cursor: pointer; display: flex; align-items: center; gap: 12px; text-align: left; padding: 12px 14px; min-height: 84px; border-radius: 20px; border: 1px solid var(--wh-line-2); background: linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.04)); transition: transform .12s ease, background-color .2s ease; touch-action: manipulation; }
.wh-vs-card:active { transform: scale(.97); }
.wh-vs-card .wh-vs-ic { width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; flex: none; }
.wh-vs-card .wh-vs-ic .wh-ico { width: 30px; height: 30px; }
.wh-vs-card b { display: block; font-size: 16.5px; font-weight: 800; line-height: 1.15; }
.wh-vs-card span { display: block; font-size: 12.5px; color: var(--wh-muted); margin-top: 3px; line-height: 1.25; }
.wh-vs-ic.gold { background: linear-gradient(160deg, #f2cf74, #c99636); color: #3a2a08; }
.wh-vs-ic.sky { background: linear-gradient(160deg, #9fd3e6, #4f93ad); color: #0d2630; }
.wh-vs-ic.leaf { background: linear-gradient(160deg, #b8da8c, #6e9e4a); color: #16230f; }
.wh-vs-card.disabled { opacity: .5; }
.wh-vs-h3 { margin: 4px 0 0; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--wh-sand); display: flex; align-items: center; gap: 8px; flex: none; }
.wh-vs-h3 small { font-size: 11.5px; letter-spacing: 0; text-transform: none; color: var(--wh-faint); font-weight: 600; }
.wh-vs-list { display: flex; flex-direction: column; gap: 8px; }
.wh-vs-row { appearance: none; font: inherit; color: inherit; display: flex; align-items: center; gap: 12px; padding: 8px 12px; min-height: 60px; border-radius: 16px; border: 1px solid var(--wh-line); background: rgba(255,255,255,.05); cursor: pointer; text-align: left; touch-action: manipulation; }
.wh-vs-row:active { transform: scale(.98); }
.wh-vs-row-t { flex: 1; min-width: 0; }
.wh-vs-row-t b { display: block; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wh-vs-row-t span { display: block; font-size: 12px; color: var(--wh-muted); }
.wh-vs-pill { flex: none; max-width: 52%; padding: 6px 12px; border-radius: 14px; font-size: 13px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: rgba(255,255,255,.08); }
.wh-vs-pill.turn { background: linear-gradient(180deg, #a6d17b, #7eae55); color: #16230f; }
.wh-vs-pill.won { background: linear-gradient(160deg, #f2cf74, #c99636); color: #3a2a08; }
.wh-vs-pill.live { background: rgba(232,92,80,.18); color: #ffb3a6; }
.wh-vs-pill.warn { background: rgba(235,184,84,.16); color: var(--wh-amber); }
.wh-vs-pill.tie { background: rgba(130,191,214,.18); color: var(--wh-sky); }
.wh-vs-empty { padding: 16px; border-radius: 16px; border: 1px dashed var(--wh-line-2); color: var(--wh-muted); font-size: 14px; text-align: center; }
.wh-vs-note { font-size: 12.5px; color: var(--wh-muted); text-align: center; }
.wh-vs-err { min-height: 18px; font-size: 14px; font-weight: 700; color: #ffb09c; text-align: center; }
.wh-vs-err.hint { color: var(--wh-amber); }
.wh-vs-foot { display: flex; gap: 10px; justify-content: center; flex: none; flex-wrap: wrap; }
.wh-vs-foot .wh-btn, .wh-vs-big { height: 54px; min-width: 180px; font-size: 17px; border-radius: 18px; padding: 0 22px; }
.wh-vs-foot .wh-btn .wh-ico { width: 24px; height: 24px; }
.wh-vs-link { appearance: none; border: 0; background: none; font: inherit; color: var(--wh-muted); text-decoration: underline; font-size: 13.5px; min-height: 40px; padding: 0 10px; cursor: pointer; }

/* lengths */
.wh-vs-lengths { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.wh-vs-len { appearance: none; font: inherit; color: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 110px; padding: 10px 8px; border-radius: 20px; border: 2px solid var(--wh-line-2); background: rgba(255,255,255,.05); text-align: center; touch-action: manipulation; }
.wh-vs-len b { font-size: 19px; font-weight: 800; }
.wh-vs-len span { font-size: 13px; color: var(--wh-sand); font-weight: 700; }
.wh-vs-len small { font-size: 11.5px; color: var(--wh-muted); line-height: 1.25; }
.wh-vs-len .wh-vs-days { display: flex; gap: 2px; margin: 2px 0; }
.wh-vs-len .wh-vs-days i { width: 6px; height: 6px; border-radius: 3px; background: #f2c46d; }
.wh-vs-len .wh-vs-days i:nth-child(2n) { background: #8fa3d6; }
.wh-vs-len.on { border-color: var(--wh-leaf); background: rgba(151,196,108,.16); box-shadow: 0 0 0 3px rgba(151,196,108,.18); }

/* code */
.wh-vs-codebox { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px; }
.wh-vs-code { font-family: ui-monospace, "Roboto Mono", "Menlo", monospace; font-size: 54px; font-weight: 800; letter-spacing: .12em; color: #fff5d6; padding: 6px 22px; border-radius: 20px; background: rgba(0,0,0,.25); border: 2px dashed rgba(228,208,160,.45); user-select: all; -webkit-user-select: all; }
.wh-vs-codebox p { margin: 0; font-size: 15px; color: var(--wh-muted); text-align: center; }

/* join boxes */
.wh-vs-boxes { display: flex; gap: 8px; justify-content: center; align-items: center; }
.wh-vs-boxes input { width: 56px; height: 66px; border-radius: 14px; border: 2px solid var(--wh-line-2); background: rgba(0,0,0,.25); color: #fff5d6; font: 800 34px ui-monospace, "Roboto Mono", monospace; text-align: center; text-transform: uppercase; outline: none; padding: 0; caret-color: var(--wh-leaf); -webkit-user-select: text; user-select: text; }
.wh-vs-boxes input:focus { border-color: var(--wh-leaf); box-shadow: 0 0 0 3px rgba(151,196,108,.25); }
.wh-vs-boxes .wh-vs-dash { width: 12px; height: 4px; border-radius: 2px; background: var(--wh-line-2); }
.wh-vs-preview { display: flex; align-items: center; gap: 14px; justify-content: center; padding: 10px 14px; border-radius: 18px; background: rgba(151,196,108,.12); border: 1px solid rgba(151,196,108,.3); }
.wh-vs-preview .wh-vs-pv b { font-size: 18px; }
.wh-vs-preview .wh-vs-pv > span { display: block; color: var(--wh-muted); font-size: 13.5px; }

/* family */
.wh-vs-people { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.wh-vs-person { appearance: none; font: inherit; color: inherit; cursor: pointer; width: 132px; min-height: 124px; border-radius: 20px; border: 2px solid var(--wh-line-2); background: rgba(255,255,255,.05); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 8px; touch-action: manipulation; }
.wh-vs-person b { font-size: 15px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh-vs-person.on { border-color: var(--wh-leaf); background: rgba(151,196,108,.16); }

/* lobby */
.wh-vs-face { display: flex; align-items: center; justify-content: center; gap: 22px; }
.wh-vs-side { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 130px; position: relative; }
.wh-vs-side b { font-size: 17px; }
.wh-vs-side span { font-size: 13px; color: var(--wh-muted); }
.wh-vs-side .wh-vs-tot { font-size: 22px; font-weight: 800; color: #fff5d6; }
.wh-vs-vs { font-size: 26px; font-weight: 900; color: var(--wh-sand); font-style: italic; }
.wh-vs-mid { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 150px; }
.wh-vs-mid .wh-vs-pill { max-width: 220px; }
.wh-vs-err:empty { min-height: 0; }
.wh-vs-rules { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.wh-vs-rule { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 14px; background: rgba(255,255,255,.05); border: 1px solid var(--wh-line); font-size: 13px; font-weight: 700; }
.wh-vs-rule .wh-ico { width: 22px; height: 22px; color: var(--wh-sand); flex: none; }
.wh-vs-meta { text-align: center; font-size: 14px; color: var(--wh-muted); }
.wh-vs-meta b { color: var(--wh-text); }

/* modal prompt over the hub */
.wh-vs-modal-back { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(6,10,8,.62); }
.wh-vs-modal { width: min(460px, 100%); border-radius: 24px; padding: 20px; text-align: center; display: flex; flex-direction: column; gap: 14px; }
.wh-vs-modal h3 { margin: 0; font-size: 21px; font-weight: 800; line-height: 1.25; }
.wh-vs-modal p { margin: 0; color: var(--wh-muted); font-size: 15px; }
.wh-vs-modal .wh-vs-foot .wh-btn { min-width: 150px; }

@media (max-width: 720px) {
  .wh-vs-cards { grid-template-columns: 1fr; }
  .wh-vs-lengths { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wh-vs-rules { grid-template-columns: 1fr; }
}
@media (max-height: 400px) {
  .wh-vs-page { gap: 8px; }
  .wh-vs-head { min-height: 46px; }
  .wh-vs-card { min-height: 74px; padding: 10px 12px; }
  .wh-vs-card .wh-vs-ic { width: 46px; height: 46px; }
  .wh-vs-len { min-height: 98px; }
  .wh-vs-code { font-size: 46px; }
  .wh-vs-foot .wh-btn, .wh-vs-big { height: 52px; }
  .wh-vs-body { gap: 7px; }
  .wh-vs-rule { padding: 5px 10px; font-size: 12.5px; }
  .wh-vs-side { gap: 2px; }
}

/* ------------------------------------------------------------ in-match chip (≤ 150 px) */
.wh-vs-chip { appearance: none; font: inherit; color: inherit; pointer-events: auto; cursor: pointer; width: 148px; max-width: 148px; height: 46px; border-radius: 16px; padding: 3px 10px 4px 9px; display: flex; flex-direction: column; justify-content: center; gap: 0; text-align: left; touch-action: manipulation; overflow: hidden; }
.wh-vs-chip:active { transform: scale(.96); }
.wh-vs-l1 { display: flex; align-items: center; gap: 5px; font-weight: 800; font-size: 15px; line-height: 18px; white-space: nowrap; }
.wh-vs-l1 .wh-ico { width: 15px; height: 15px; color: #f2c46d; flex: none; }
.wh-vs-l2 { display: flex; align-items: center; gap: 5px; font-weight: 700; font-size: 12.5px; line-height: 17px; color: var(--wh-muted); white-space: nowrap; overflow: hidden; }
.wh-vs-l2 .wh-vs-sc { overflow: hidden; text-overflow: ellipsis; }
.wh-vs-l2 b { color: var(--wh-text); }
.wh-vs-dot { width: 7px; height: 7px; border-radius: 50%; background: #e85c50; box-shadow: 0 0 8px #e85c50; flex: none; display: none; }
.wh-vs-chip.live .wh-vs-dot { display: block; animation: wh-vs-blink 1.4s ease-in-out infinite; }
.wh-vs-chip.amber .wh-vs-l1 { color: var(--wh-amber); }
.wh-vs-chip.night .wh-vs-l1 .wh-ico { color: #b9c8ef; }
.wh-vs-chip.night .wh-vs-l1 { font-size: 13px; }
@keyframes wh-vs-blink { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

/* ------------------------------------------------------------ in-match overlays */
.wh-vs-layer { position: absolute; inset: 0; pointer-events: auto; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 12px; }
.wh-vs-count { background: rgba(6,12,8,.42); flex-direction: column; gap: 6px; text-align: center; touch-action: none; }
.wh-vs-count h3 { margin: 0; font-size: 24px; font-weight: 800; text-shadow: 0 2px 12px rgba(0,0,0,.5); }
.wh-vs-count p { margin: 0; font-size: 17px; font-weight: 700; color: var(--wh-sand); text-shadow: 0 2px 10px rgba(0,0,0,.5); }
.wh-vs-num { font-size: 120px; line-height: 1; font-weight: 900; color: #fff5d6; text-shadow: 0 6px 30px rgba(0,0,0,.5); animation: wh-vs-tick 1s ease-out infinite; }
.wh-vs-num.go { color: var(--wh-leaf-2); animation: none; }
@keyframes wh-vs-tick { 0% { transform: scale(1.25); opacity: .4; } 25% { transform: scale(1); opacity: 1; } 100% { transform: scale(.92); opacity: .9; } }

.wh-vs-sheet { position: absolute; top: calc(var(--wh-gt) + 54px); right: var(--wh-gr); width: min(440px, calc(100% - 20px)); max-height: calc(100% - var(--wh-gt) - 62px); overflow-y: auto; scrollbar-width: none; pointer-events: auto; z-index: 40; border-radius: 20px; padding: 10px 12px 12px; }
.wh-vs-sheet-h { display: grid; grid-template-columns: 1fr 64px 64px 36px; align-items: center; gap: 4px; font-size: 12.5px; font-weight: 800; }
.wh-vs-sheet-h .wh-vs-who { display: flex; flex-direction: column; align-items: center; gap: 2px; overflow: hidden; }
.wh-vs-sheet-h .wh-vs-who span { max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wh-vs-sheet-r { display: grid; grid-template-columns: 1fr 64px 64px; align-items: center; gap: 4px; padding: 5px 0; border-top: 1px solid var(--wh-line); }
.wh-vs-sheet-r .wh-vs-cat { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wh-vs-sheet-r .wh-vs-cat .wh-ico { width: 20px; height: 20px; color: var(--wh-sand); flex: none; }
.wh-vs-sheet-r .wh-vs-cat div { min-width: 0; }
.wh-vs-sheet-r .wh-vs-cat b { display: block; font-size: 13.5px; }
.wh-vs-sheet-r .wh-vs-cat small { display: block; font-size: 11px; color: var(--wh-muted); line-height: 1.2; }
.wh-vs-sheet-r .wh-vs-n { text-align: center; font-weight: 800; font-size: 14px; }
.wh-vs-sheet-r .wh-vs-n.lead { color: var(--wh-leaf-2); }
.wh-vs-sheet-f { display: flex; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--wh-line); font-size: 13px; color: var(--wh-muted); }
.wh-vs-sheet-f b { color: var(--wh-text); }

.wh-vs-pops { position: absolute; top: calc(var(--wh-gt) + 58px); left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; z-index: 35; width: min(520px, 90%); }
.wh-vs-pop { padding: 7px 14px; border-radius: 16px; font-weight: 800; font-size: 15px; text-align: center; animation: wh-vs-pop 2.6s ease both; max-width: 100%; }
.wh-vs-pop.good { color: var(--wh-leaf-2); }
.wh-vs-pop.bad { color: #ffb09c; }
.wh-vs-pop.day { color: #f2cf74; }
@keyframes wh-vs-pop { 0% { opacity: 0; transform: translateY(10px) scale(.9); } 10% { opacity: 1; transform: none; } 80% { opacity: 1; } 100% { opacity: 0; transform: translateY(-12px); } }

.wh-vs-end { background: rgba(6,10,8,.55); }
.wh-vs-endcard { position: relative; width: min(760px, 100%); max-height: 100%; overflow-y: auto; scrollbar-width: none; border-radius: 24px; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.wh-vs-endcard h2 { margin: 0; text-align: center; font-size: 28px; font-weight: 900; color: #fff5d6; }
.wh-vs-endcard .wh-vs-line { text-align: center; font-size: 15px; color: var(--wh-muted); margin-top: -4px; }
.wh-vs-endgrid { display: grid; grid-template-columns: 250px 1fr; gap: 16px; align-items: center; }
.wh-vs-podium { display: flex; justify-content: center; align-items: flex-end; gap: 14px; }
.wh-vs-podium .wh-vs-side { min-width: 100px; }
.wh-vs-podium .wh-vs-step { width: 96px; border-radius: 12px 12px 4px 4px; background: linear-gradient(180deg, rgba(228,208,160,.35), rgba(228,208,160,.1)); display: flex; align-items: flex-start; justify-content: center; padding-top: 4px; font-weight: 900; font-size: 20px; color: #fff5d6; }
.wh-vs-crown { position: absolute; top: -20px; left: 50%; transform: translateX(-50%) rotate(-8deg); color: #f2cf74; filter: drop-shadow(0 2px 6px rgba(0,0,0,.4)); }
.wh-vs-crown .wh-ico { width: 30px; height: 30px; }
.wh-vs-bars { display: flex; flex-direction: column; gap: 3px; }
.wh-vs-bar { display: grid; grid-template-columns: 22px 1fr 1fr; gap: 6px; align-items: center; font-size: 11.5px; }
.wh-vs-bar .wh-ico { width: 18px; height: 18px; color: var(--wh-sand); }
.wh-vs-bar .wh-vs-b { position: relative; height: 14px; border-radius: 7px; background: rgba(255,255,255,.06); overflow: hidden; }
.wh-vs-bar .wh-vs-b i { position: absolute; top: 0; bottom: 0; border-radius: 7px; }
.wh-vs-bar .wh-vs-b.me i { right: 0; background: linear-gradient(90deg, #7eae55, #a6d17b); }
.wh-vs-bar .wh-vs-b.them i { left: 0; background: linear-gradient(90deg, #6fa5c0, #9fd3e6); }
.wh-vs-bar .wh-vs-b em { position: absolute; top: 0; bottom: 0; font-style: normal; font-weight: 800; line-height: 14px; font-size: 10.5px; color: #10170f; padding: 0 5px; }
.wh-vs-bar .wh-vs-b.me em { right: 0; }
.wh-vs-bar .wh-vs-b.them em { left: 0; }
.wh-vs-chart { width: 100%; height: 74px; display: block; }
.wh-vs-chart .me { stroke: #a6d17b; }
.wh-vs-chart .them { stroke: #9fd3e6; }
.wh-vs-close { text-align: center; font-weight: 900; color: var(--wh-amber); letter-spacing: .06em; }
.wh-vs-endbtns { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.wh-vs-endbtns .wh-btn { height: 50px; min-width: 150px; font-size: 16px; border-radius: 16px; }
.wh-vs-timesup h2 { font-size: 64px; }
.wh-vs-endcard .wh-confetti { top: 30%; }
@media (max-width: 700px) {
  .wh-vs-endgrid { grid-template-columns: 1fr; }
}
@media (max-height: 420px) {
  .wh-vs-sheet { padding: 6px 12px 8px; }
  .wh-vs-sheet-h { font-size: 12px; }
  .wh-vs-sheet-r { padding: 3px 0; }
  .wh-vs-sheet-r .wh-vs-cat b { font-size: 13px; line-height: 16px; }
  .wh-vs-sheet-r .wh-vs-cat small { font-size: 10.5px; line-height: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wh-vs-sheet-f { padding-top: 5px; }
  .wh-vs-sheet .wh-vs-note { display: none; }
}
@media (max-height: 400px) {
  .wh-vs-endcard { padding: 10px 14px; gap: 6px; }
  .wh-vs-endcard h2 { font-size: 24px; }
  .wh-vs-timesup h2 { font-size: 52px; }
  .wh-vs-endbtns .wh-btn { height: 46px; }
}
`;

let injected = false;

/** Add the versus stylesheet (and the shell's, which it builds on) to the document once. */
export function injectVersusStyles(): void {
  if (typeof document === 'undefined') return;
  ensureStyles();
  if (injected) return;
  injected = true;
  if (document.getElementById('wh-vs-style')) return;
  const s = document.createElement('style');
  s.id = 'wh-vs-style';
  s.textContent = CSS;
  document.head.append(s);
}
