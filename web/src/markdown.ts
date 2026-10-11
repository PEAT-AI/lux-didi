// Minimal, dependency-free Markdown to safe HTML. Every model-supplied string is
// escaped; only http: and https: links become anchors. No raw HTML passes through.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPES[character]!);
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const FENCE = /^```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+/;

/** Inline spans over already HTML-escaped text. Held spans are restored last so
 * emphasis never re-parses code or link markup. */
function inline(raw: string): string {
  const held: string[] = [];
  const hold = (html: string) => { held.push(html); return `\u0000${held.length - 1}\u0000`; };
  let text = escapeHtml(raw);
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => hold(`<code>${code}</code>`));
  text = text.replace(LINK, (match, label: string, href: string) => {
    if (!/^https?:\/\//i.test(href)) return match;
    return hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => held[Number(index)]!);
}

export function renderMarkdown(source: string): string {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') { index++; continue; }
    if (FENCE.test(line)) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !FENCE.test(lines[index]!)) { body.push(lines[index]!); index++; }
      if (index < lines.length) index++;
      blocks.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) { const level = heading[1]!.length; blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`); index++; continue; }
    if (BULLET.test(line)) {
      const items: string[] = [];
      while (index < lines.length && BULLET.test(lines[index]!)) { items.push(`<li>${inline(lines[index]!.replace(BULLET, ''))}</li>`); index++; }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== '' && !FENCE.test(lines[index]!) && !HEADING.test(lines[index]!) && !BULLET.test(lines[index]!)) { paragraph.push(inline(lines[index]!)); index++; }
    blocks.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return blocks.join('\n');
}
