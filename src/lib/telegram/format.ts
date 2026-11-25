// The agent writes light Markdown; Telegram renders a small HTML subset (b, i, s, u, code,
// pre, a, blockquote — no headings, no lists). Convert, escape <>&, and split long replies at
// paragraph boundaries so no message exceeds 4096 characters and no tag spans two messages.

export const TG_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

/** Inline Markdown of one line (already free of code spans) → HTML. */
function inline(line: string): string {
  let s = escapeHtml(line);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text: string, url: string) => `<a href="${escapeAttr(url.replace(/&amp;/g, '&'))}">${text}</a>`);
  s = s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(?=\S)([^_\n]*?\S)__/g, '<b>$1</b>');
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[\s(«"])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s.,;:!?)»"])/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(«"])_(?=\S)([^_\n]*?\S)_(?=$|[\s.,;:!?)»"])/g, '$1<i>$2</i>');
  return s;
}

type Block = { kind: 'code'; lang: string; body: string } | { kind: 'text'; body: string };

function splitCodeFences(md: string): Block[] {
  const out: Block[] = [];
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    if (m.index > last) out.push({ kind: 'text', body: md.slice(last, m.index) });
    out.push({ kind: 'code', lang: m[1], body: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ kind: 'text', body: md.slice(last) });
  return out;
}

function textBlock(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.join('\n')}</blockquote>`); quote = []; } };
  for (const raw of lines) {
    // Code spans first: their content is escaped but never formatted.
    const parts = raw.split(/(`[^`\n]+`)/g);
    const render = (l: string) => parts.length > 1
      ? l.split(/(`[^`\n]+`)/g).map((p) => (p.startsWith('`') && p.endsWith('`') && p.length > 1 ? `<code>${escapeHtml(p.slice(1, -1))}</code>` : inline(p))).join('')
      : inline(l);
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    const bullet = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    const quoted = raw.match(/^\s*>\s?(.*)$/);
    if (quoted) { quote.push(render(quoted[1])); continue; }
    flushQuote();
    if (heading) out.push(`<b>${render(heading[1])}</b>`);
    else if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw)) out.push('');
    else if (bullet) out.push(`${bullet[1]}• ${render(bullet[2])}`);
    else if (/^\s*\|.*\|\s*$/.test(raw)) {
      // Tables do not render in Telegram: keep the cells, drop the separator rows.
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(raw)) out.push(raw.trim().replace(/^\||\|$/g, '').split('|').map((c) => render(c.trim())).join(' · '));
    } else out.push(render(raw));
  }
  flushQuote();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Markdown → Telegram HTML (one message, no length limit applied). */
export function toTelegramHtml(md: string): string {
  return splitCodeFences(md.replace(/\r\n/g, '\n'))
    .map((b) => (b.kind === 'code' ? `<pre>${b.lang ? `<code class="language-${escapeAttr(b.lang)}">` : ''}${escapeHtml(b.body)}${b.lang ? '</code>' : ''}</pre>` : textBlock(b.body)))
    .join('')
    .trim();
}

/** Visible length of Telegram HTML (what the 4096 limit counts). */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot);/g, '_').length;
}

function hardSplit(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = Math.max(rest.lastIndexOf('\n', limit), rest.lastIndexOf('. ', limit) + 1, rest.lastIndexOf(' ', limit));
    const at = cut > limit * 0.5 ? cut : limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Markdown → Telegram HTML messages, each within the limit. Splits by paragraphs (then lines,
 * then words), converting each piece on its own so tags never cross a message boundary.
 */
export function toTelegramMessages(md: string, limit = TG_LIMIT): string[] {
  const units = md.replace(/\r\n/g, '\n').split(/\n{2,}/).flatMap((p) => (toTelegramHtml(p).length > limit ? p.split('\n') : [p]))
    .flatMap((p) => (toTelegramHtml(p).length > limit ? hardSplit(p, Math.floor(limit / 2)) : [p]));
  const messages: string[] = [];
  let current = '';
  for (const u of units) {
    const candidate = current ? `${current}\n\n${u}` : u;
    if (toTelegramHtml(candidate).length <= limit) { current = candidate; continue; }
    if (current) messages.push(toTelegramHtml(current));
    current = u;
  }
  if (current.trim()) messages.push(toTelegramHtml(current));
  return messages.filter(Boolean);
}

/** HTML → plain text, the fallback when Telegram rejects the markup. */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
