// The public tree is vanilla: the owner's real mailbox and the owner's home directory never appear in a
// tracked file, because owner specifics come from the private owner profile and provider configuration at
// runtime. The patterns below match the STRUCTURE of real data (an address at a domain that is not
// reserved for documentation, an absolute home path that is not the documented example account), never
// the owner's own address, so the guard cannot itself become the leak it forbids.
// A plain script rather than a compiled test, so it reads the tree as tracked and needs no build.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();

/** The trees this guard owns: everything the product and its documentation ship. */
const SCOPES = ['server/', 'web/', 'docs/', 'scripts/', 'README.md', 'CLAUDE.md'];

/** RFC 2606 and RFC 6761 names: documentation, test and local domains are synthetic by construction. */
const RESERVED_DOMAIN = /(?:^|\.)(?:example|invalid|test|localhost|local|example\.(?:com|net|org))$/u;
/** Public vendor domains a fixture may legitimately quote, for example an OpenAPI spec's author address. */
const VENDOR_DOMAIN = /(?:^|\.)(?:google\.com|trello\.com|atlassian\.com)$/u;
/** One address in a fixture whose domain exists only to be refused: never a real mailbox. */
const SYNTHETIC_ADDRESSES = new Set(['owner@example.test.evil']);
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
/** An absolute home path, and the one account name this repository documents as a placeholder. */
const HOME_PATH = /\/Users\/([A-Za-z0-9._-]+)/gu;
const PLACEHOLDER_ACCOUNT = 'example';

/** Every tracked text file in scope, by path relative to the repository root. */
function scopeFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    .filter(file => SCOPES.some(scope => (scope.endsWith('/') ? file.startsWith(scope) : file === scope)));
}

function textOf(file) {
  try {
    const body = readFileSync(join(ROOT, file), 'utf8');
    return body.includes('\0') ? undefined : body;
  } catch { return undefined; }
}

const lineOf = (body, index) => body.slice(0, index).split('\n').length;
const listed = hits => hits.map(hit => `${hit.file}:${hit.line}: ${hit.text}`).join('\n');

function scan(match) {
  const hits = [];
  for (const file of scopeFiles()) {
    const body = textOf(file);
    if (body === undefined) continue;
    for (const hit of match(body)) hits.push({ file, line: lineOf(body, hit.index), text: hit.text });
  }
  return hits;
}

/** Test one: every address in a tracked file is documentation, test, or a public vendor's. */
const mailboxHits = scan(body => [...body.matchAll(ADDRESS)].flatMap(match => {
  const address = match[0];
  const domain = address.slice(address.indexOf('@') + 1).toLowerCase();
  if (RESERVED_DOMAIN.test(domain) || VENDOR_DOMAIN.test(domain) || SYNTHETIC_ADDRESSES.has(address)) return [];
  return [{ index: match.index, text: address }];
}));

/** Test two: the only home path account any tracked file names is the documented placeholder. */
const pathHits = scan(body => [...body.matchAll(HOME_PATH)].flatMap(match => (
  match[1] === PLACEHOLDER_ACCOUNT ? [] : [{ index: match.index, text: match[0] }]
)));

const files = scopeFiles();
assert.ok(files.length > 500, `the guard scanned ${files.length} tracked files`);
assert.ok(files.some(file => file.startsWith('server/test/')), 'the tests are in scope');
assert.ok(files.some(file => file.startsWith('scripts/')), 'scripts are in scope');
assert.deepEqual(mailboxHits, [], `a real mailbox in a tracked file:\n${listed(mailboxHits)}`);
assert.deepEqual(pathHits, [], `an owner home path in a tracked file:\n${listed(pathHits)}`);
console.log(JSON.stringify({ guard: 'vanilla_tree', files: files.length, mailboxes: 0, owner_paths: 0 }));
