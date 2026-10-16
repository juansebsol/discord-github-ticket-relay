/**
 * A small, safe Markdown renderer for the TRIAGE.md files Claude writes: headings, lists,
 * paragraphs, **bold**, `code`, links, and issue numbers (#123, owner/repo#123) linked to GitHub.
 * The text is escaped first; only these tags are put back, and links only go to http(s) URLs.
 */
import { escapeHtml, raw, type SafeHtml } from '../lib/html.js';

const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';

function inline(text: string, repoUrl: string): string {
  let s = escapeHtml(text);
  // Code first, kept aside so nothing inside it is touched.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<a href="${u}" ${EXTERNAL}>${t}</a>`);
  // A bare URL, without the punctuation that ends its sentence.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, u: string) => {
    const tail = /[.,;:!?]+$/.exec(u)?.[0] ?? '';
    const url = tail ? u.slice(0, -tail.length) : u;
    return `${pre}<a href="${url}" ${EXTERNAL}>${url}</a>${tail}`;
  });
  s = s.replace(/(^|[\s([,;:])((?:[\w.-]+\/[\w.-]+)?#(\d+))\b/g, (_m, pre: string, ref: string, n: string) => {
    const url = ref.includes('/') ? `https://github.com/${ref.replace('#', '/issues/')}` : `${repoUrl}/issues/${n}`;
    return `${pre}<a href="${url}" ${EXTERNAL}>${ref}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
}

/** `repoUrl`: where bare issue numbers point (https://github.com/owner/repo). */
export function renderMarkdown(md: string, repoUrl: string): SafeHtml {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '), repoUrl)}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    let m: RegExpExecArray | null;
    if (!t || t === '-' || t === '*') {
      flush();
      if (!t) closeList();
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) {
      flush();
      closeList();
      const level = m[1]!.length <= 2 ? 3 : 4;
      out.push(`<h${level}>${inline(m[2]!, repoUrl)}</h${level}>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(t);
    const numbered = bullet ? null : /^\d+[.)]\s+(.*)$/.exec(t);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1]!, repoUrl)}</li>`);
      continue;
    }
    // An indented line goes on with the list item above it.
    if (list && /^\s{2,}/.test(line)) {
      out[out.length - 1] = out[out.length - 1]!.replace(/<\/li>$/, ` ${inline(t, repoUrl)}</li>`);
      continue;
    }
    closeList();
    para.push(t);
  }
  flush();
  closeList();
  return raw(out.join(''));
}
