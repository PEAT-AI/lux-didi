import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ServiceError } from '../contracts/errors.js';

// Exact accepted web/security-headers.json policy; no inline/remote script or device grants.
const headers = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; worker-src 'self'; manifest-src 'self'",
  'Permissions-Policy': 'microphone=(), camera=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const shellFiles: Record<string, string> = {
  '/index.html': 'text/html; charset=utf-8',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/manifest.webmanifest': 'application/manifest+json',
  '/icon.svg': 'image/svg+xml',
  '/third-party-notices.txt': 'text/plain; charset=utf-8',
};
const assetTypes: Record<string, string> = {
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2',
};

export async function createStaticHandler(webRoot: string) {
  const root = await realpath(resolve(webRoot));
  if (!(await stat(root)).isDirectory()) throw new Error('Web build root must be a directory');
  async function file(path: string) {
    const target = await realpath(resolve(root, `.${path}`));
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new ServiceError('FORBIDDEN', 'Web path outside build', 403);
    if (!(await stat(target)).isFile()) throw new ServiceError('NOT_FOUND', 'Web file not found', 404);
    return target;
  }
  // A repository/data directory or half-built shell is not a deployable web build.
  const html = await readFile(await file('/index.html'), 'utf8');
  for (const path of ['/sw.js', '/manifest.webmanifest', '/icon.svg']) await file(path);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(match => match[1]!);
  if (!assets.some(path => path.endsWith('.js')) || !assets.some(path => path.endsWith('.css'))) throw new Error('Invalid web build: missing compiled script/style assets');
  for (const path of assets) await file(path);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const raw = (req.url ?? '/').split('?')[0]!;
    // Preserve the entire API namespace, including errors, in the existing router.
    if (raw === '/health' || raw === '/api' || raw.startsWith('/api/')) return false;
    let path: string;
    try { path = decodeURIComponent(raw); } catch { throw new ServiceError('BAD_REQUEST', 'Invalid web path'); }
    if (!path.startsWith('/') || /[%\\\x00-\x1f]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw new ServiceError('FORBIDDEN', 'Invalid web path', 403);
    if (path === '/') path = '/index.html';
    const type = shellFiles[path] ?? (/^\/assets\/[A-Za-z0-9_./-]+$/.test(path) ? assetTypes[path.split('.').at(-1)!] : undefined);
    if (!type) throw new ServiceError('NOT_FOUND', 'Web file not found', 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new ServiceError('NOT_FOUND', 'Web route not found', 404);
    let content: Buffer;
    try { content = await readFile(await file(path)); }
    catch (error) {
      if (error instanceof ServiceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new ServiceError('NOT_FOUND', 'Web file not found', 404);
      throw error;
    }
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': content.byteLength });
    res.end(req.method === 'HEAD' ? undefined : content);
    return true;
  };
}
