// Disposable actual Node/SQLite/listener supervision fixture, not accepted HOST integration.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const state = args[args.indexOf('--data-dir') + 1];
const mode = fs.readFileSync(path.join(__dirname, 'mode'), 'utf8');
let startup = Buffer.alloc(0), started = false, db, server;
function close() {
  const finish = () => { if (db) db.close(); process.exit(0); };
  if (server) server.close(finish); else finish();
}
process.stdin.on('data', chunk => {
  if (started) return process.exit(2);
  startup = Buffer.concat([startup, chunk]);
  if (startup.length > 1024) return process.exit(2);
  if (!startup.includes(10)) return;
  let input;
  try { input = JSON.parse(startup.toString('utf8')); } catch { return process.exit(2); }
  if (Object.keys(input).sort().join(',') !== 'nonce,schemaVersion,type' || input.type !== 'start' || input.schemaVersion !== 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce)) return process.exit(2);
  started = true;
  if (mode === 'exit') return process.exit(3);
  if (mode === 'silent') return;
  try {
    db = new DatabaseSync(path.join(state, 'supervision-proof.sqlite'));
    db.exec('BEGIN EXCLUSIVE'); // Actual second-writer exclusion, no business schema.
  } catch { return process.exit(4); }
  const credential = path.join(state, 'admin-credential');
  if (!fs.existsSync(credential)) fs.writeFileSync(credential, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
  server = http.createServer((request, response) => { response.end('fixture'); });
  server.listen(0, '127.0.0.1', () => {
    const ready = { type: 'ready', schemaVersion: 1, nonce: input.nonce, pid: process.pid,
      origin: `http://127.0.0.1:${server.address().port}`, authorityEpoch: crypto.randomUUID(), assistantId: crypto.randomUUID() };
    if (mode === 'stale') ready.nonce = crypto.randomBytes(32).toString('base64url');
    if (mode === 'peer') ready.origin = 'http://localhost:1234';
    if (mode === 'pid') ready.pid += 1;
    if (mode === 'epoch') ready.authorityEpoch = 'not-an-epoch';
    if (mode === 'malformed') return process.stdout.write('not JSON\n');
    if (mode === 'oversize') return process.stdout.write('x'.repeat(1025) + '\n');
    const line = JSON.stringify(ready) + '\n';
    const frame = mode === 'extra' ? line + line : line;
    process.stdout.write(frame, () => fs.writeFileSync(path.join(state, 'fixture-ready.json'), JSON.stringify({ pid: process.pid, bytes: Buffer.byteLength(frame), flushed: true })));

  });
});
process.stdin.on('end', () => { if (mode !== 'stubborn') close(); });
process.on('SIGTERM', () => { if (mode !== 'stubborn') close(); });
