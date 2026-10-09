import { defineConfig } from 'vite';
// Generate an exact app-shell allowlist. No runtime API caching or offline writer.
export default defineConfig({
  server: { host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:4317' }, '/health': { target: 'http://127.0.0.1:4317' } } },
  plugins: [{ name: 'private-shell-only', generateBundle(_options, bundle) {
    const files = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest', ...Object.keys(bundle).filter(p => p.startsWith('assets/')).map(p => `/${p}`)];
    const name = `didi-shell-${Object.keys(bundle).join('-')}`;
    this.emitFile({type: 'asset', fileName: 'sw.js', source: `
const CACHE=${JSON.stringify(name)}, SHELL=${JSON.stringify(files)};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('didi-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!SHELL.includes(url.pathname)||url.search) return;
  event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(cache=>cache.match(url.pathname))));
});
` });
  } }],
});
