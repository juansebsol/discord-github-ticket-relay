/**
 * The Live studio (AI triage › Knowledge, while Claude writes the TRIAGE.md files) and its pill.
 * Every page carries this markup while a run is on or just finished; app.js opens it, polls the
 * live endpoint and fills it in. Opening "Write all" opens the studio; minimized, the pill
 * follows you to every page, with a note as each app is done.
 */
import { html, raw, type SafeHtml } from '../lib/html.js';
import { icon } from './ui.js';

export function knowledgeLive(o: { base: string; csrf: string; wid: string; edit: boolean }): SafeHtml {
  return html`<div id="kn-live" data-src="${o.base}/triage/knowledge/live" data-stop="${o.base}/triage/knowledge/stop" data-page="${o.base}/triage/knowledge" data-csrf="${o.csrf}" data-ws="${o.wid}" ${o.edit ? raw('data-edit') : ''} hidden>
  <div class="kn-pill-wrap" data-kn-pillwrap hidden>
    <button type="button" class="kn-pill" data-kn-pill>
      <span class="kn-ring" aria-hidden="true"><svg viewBox="0 0 40 40" width="40" height="40"><circle class="kn-ring-track" cx="20" cy="20" r="16"/><circle class="kn-ring-bar" cx="20" cy="20" r="16" data-kn-ring/></svg><span class="kn-ring-n" data-kn-count></span></span>
      <span class="kn-pill-t"><span class="t"><span class="kn-pill-ic" data-kn-pill-ic></span><span data-kn-pill-title></span></span><span class="s" data-kn-pill-sub></span></span>
      <span class="kn-pill-go" aria-hidden="true">${icon('chevron-up', 16)}</span>
    </button>
    <button type="button" class="kn-pill-x" data-kn-pill-close aria-label="Close" hidden>${icon('x', 14)}</button>
  </div>
</div>
<dialog class="kn-studio" id="kn-studio" aria-labelledby="kn-st-title">
  <header class="kn-st-h">
    <span class="kn-st-ic" aria-hidden="true">${icon('sparkles', 20)}</span>
    <div class="kn-st-tt"><h2 id="kn-st-title" data-kn-title>Claude is writing your TRIAGE.md files</h2><p class="kn-st-sub" data-kn-sub></p></div>
    <div class="kn-st-act">
      <button type="button" class="btn" data-kn-min>${icon('minus', 14)}<span class="lbl">Minimize</span></button>
      ${o.edit
        ? html`<span class="kn-st-stop" data-kn-stopwrap>
            <button type="button" class="btn danger-outline" data-kn-stopall>${icon('square', 12)}<span class="lbl">Stop all</span></button>
            <span class="kn-st-confirm" data-kn-confirm hidden><span>Stop writing the rest?</span><button type="button" class="btn sm danger-solid" data-kn-stopyes>Stop all</button><button type="button" class="btn sm" data-kn-stopno>Keep going</button></span>
          </span>`
        : ''}
      <span class="kn-st-msg" data-kn-msg role="status"></span>
      <button type="button" class="btn primary" data-kn-done hidden>Done</button>
    </div>
  </header>
  <div class="kn-st-bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-kn-progress><span data-kn-bar></span></div>
  <div class="kn-st-body">
    <nav class="kn-st-queue" aria-label="Apps in this run"><div class="kn-st-lbl">Queue</div><ul data-kn-queue></ul></nav>
    <section class="kn-st-main" aria-label="TRIAGE.md">
      <div class="kn-st-doch"><span class="kn-st-av" data-kn-av aria-hidden="true"></span><span class="kn-st-name" data-kn-name></span><span class="kn-st-file">TRIAGE.md</span><span class="kn-st-steps" data-kn-steps></span></div>
      <div class="kn-st-scroll" data-kn-scroll><article class="kn-doc" data-kn-doc></article><p class="kn-st-empty" data-kn-empty hidden></p></div>
      <div class="kn-st-docf"><span class="kn-st-tok" data-kn-tokens></span><svg class="kn-spark" viewBox="0 0 120 24" width="120" height="24" aria-hidden="true"><polyline data-kn-spark points=""/></svg>
        <span class="kn-st-docact"><button type="button" class="btn sm" data-kn-follow hidden>Follow Claude</button>${o.edit ? html`<button type="button" class="btn sm danger-outline" data-kn-skip hidden></button>` : ''}</span></div>
    </section>
    <aside class="kn-st-log" aria-label="Live log">
      <div class="kn-st-logh"><span>Live log</span><span class="kn-st-live" data-kn-live><span class="dot"></span><span data-kn-livet>Live</span></span></div>
      <ol class="kn-st-lines" data-kn-log></ol>
      <div class="kn-st-qs" data-kn-qs hidden><div class="kn-st-qsh"><span>Its questions</span><span data-kn-qcount></span></div><ul data-kn-answers></ul></div>
    </aside>
  </div>
</dialog>
<template id="kn-icons">
  <span data-i="running">${icon('loader-circle', 14, 'kn-spin')}</span>
  <span data-i="queued">${icon('clock', 14)}</span>
  <span data-i="done">${icon('circle-check', 14)}</span>
  <span data-i="failed">${icon('triangle-alert', 14)}</span>
  <span data-i="stopped">${icon('circle-slash', 14)}</span>
  <span data-i="x">${icon('x', 14)}</span>
</template>`;
}
