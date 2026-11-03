// Shared structural mail cleaning. No result-size or voice policy.
const MIME_LINE = /^(content-type|content-transfer-encoding|mime-version|content-disposition|content-id|x-attachment-id|boundary)\s*:/i;
const QUOTE_MARKERS = [
  /^>+/m,
  /^on .+ wrote:$/im,
  /^-{2,}\s*original message\s*-{2,}$/im,
  /^_{10,}$/m,
  /^from:\s.+\r?\n(?:sent|to|subject):/im,
];
const SIGNATURE_MARKERS = [/^--\s*$/m, /^sent from my /im, /^get outlook for /im];
const TRACKING_QUERY = /[?&](?:utm_|fbclid|gclid|mc_eid|mc_cid|_hsenc|_hsmi|mkt_tok)=/i;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const CID_REF = /\[cid:[^\]]+\]|src=["']cid:[^"']+["']/gi;

/** Decode the HTML entities a mail snippet or header carries into plain text, once, at the
 * boundary where the connector result becomes model text. The UI never unescapes: it keeps
 * rendering this text as text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi, match => {
    const body = match.slice(1, -1).toLowerCase();
    switch (body) {
      case 'nbsp': return ' ';
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': case '#39': case '#x27': return "'";
      default: break;
    }
    const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : body.startsWith('#') ? Number.parseInt(body.slice(1), 10) : Number.NaN;
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
/** Convert an HTML mail body to plain text: drop script/style, break on block tags, strip the rest. */
export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/** Strip every quoted reply chain below the first marker (keeps the new message only). */
export function stripQuotedReply(text: string): string {
  let cut = -1;
  for (const pattern of QUOTE_MARKERS) {
    const match = pattern.exec(text);
    if (match && (cut === -1 || match.index < cut)) cut = match.index;
  }
  return cut >= 0 ? text.slice(0, cut).trimEnd() : text;
}
/** Drop a trailing signature block. */
export function stripSignature(text: string): string {
  let cut = -1;
  for (const pattern of SIGNATURE_MARKERS) {
    const match = pattern.exec(text);
    if (match && (cut === -1 || match.index < cut)) cut = match.index;
  }
  return cut >= 0 ? text.slice(0, cut).trimEnd() : text;
}
/** Remove tracking-only URLs, leaving meaningful links and source links intact. */
export function stripTrackingUrls(text: string): string {
  return text.split('\n').map(line => {
    const urls = line.match(/https?:\/\/[^\s)]+/g) ?? [];
    if (!urls.length || !urls.every(url => TRACKING_QUERY.test(url))) return line;
    let cleaned = line;
    for (const url of urls) cleaned = cleaned.split(url).join(''.padEnd(0));
    return cleaned.replace(/[<(]\s*[)>]/g, '').replace(/\s{2,}/g, ' ').trimEnd();
  }).join('\n');
}
/** Full mail-body cleaning pipeline: MIME boilerplate, inline data, HTML, quotes, signature, trackers. */
export function cleanMailBody(raw: string): string {
  let body = raw;
  body = body.split('\n').filter(line => !MIME_LINE.test(line.trim())).join('\n');
  body = body.replace(DATA_IMAGE, '').replace(CID_REF, '');
  if (/<\w+[\s>]/.test(body)) body = htmlToText(body);
  else body = decodeEntities(body);
  body = stripQuotedReply(body);
  body = stripSignature(body);
  body = stripTrackingUrls(body);
  return body.replace(/\n{3,}/g, '\n\n').trim();
}
