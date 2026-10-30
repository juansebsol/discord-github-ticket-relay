/**
 * A tool's Docs tab: a guide with its contents beside it (on top on a phone). Each tool writes
 * its own sections (docs/mcp.ts is the first); this lays them out the same way.
 */
import { html, type SafeHtml } from '../../lib/html.js';

export interface DocSection {
  id: string;
  title: string;
  body: SafeHtml;
}

export function docPage(o: { intro: SafeHtml; sections: DocSection[] }): SafeHtml {
  return html`<div class="docs">
    <nav class="docs-toc" aria-label="On this page"><div class="docs-toc-h">On this page</div>
      <ol>${o.sections.map((s) => html`<li><a href="#${s.id}">${s.title}</a></li>`)}</ol>
    </nav>
    <article class="docs-body">
      <div class="docs-intro">${o.intro}</div>
      ${o.sections.map((s) => html`<section class="docs-s" id="${s.id}" aria-labelledby="${s.id}-h"><h2 id="${s.id}-h">${s.title}</h2>${s.body}</section>`)}
    </article>
  </div>`;
}

/** A short highlighted note inside a guide. */
export function docNote(text: SafeHtml | string, tone: 'info' | 'warn' = 'info'): SafeHtml {
  return html`<div class="docs-note ${tone}">${text}</div>`;
}
