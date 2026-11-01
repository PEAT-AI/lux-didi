// The public tree is vanilla: the owner's real mailbox and the owner's home directory never appear in a
// tracked file, because owner specifics come from the private owner profile and provider configuration at
// runtime. The patterns below match the STRUCTURE of real data (an address at a domain that is not
// reserved for documentation, an absolute home path that is not the documented example account), never
// the owner's own address, so the guard cannot itself become the leak it forbids.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();

/** The trees this guard owns: everything the product and its documentation ship. */
const SCOPES = ['server/', 'web/', 'docs/', 'scripts/', 'README.md', 'CLAUDE.md'] as const;

/** RFC 2606 and RFC 6761 names: documentation, test and local domains are synthetic by construction. */
const RESERVED_DOMAIN = /(?:^|\.)(?:example|invalid|test|localhost|local|example\.(?:com|net|org))$/u;
/** Public vendor domains a fixture may legitimately quote, for example an OpenAPI spec's author address. */
const VENDOR_DOMAIN = /(?:^|\.)(?:google\.com|trello\.com|atlassian\.com)$/u;
/** One address in a fixture whose domain exists only to be refused: never a real mailbox. */
const SYNTHETIC_ADDRESSES = new Set(['owner@example.test.evil']);
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
/** An absolute macOS home path, and the one account name the repository documents as a placeholder. */
const HOME_PATH = /\/Users\/([A-Za-z0-9._-]+)/gu;
const PLACEHOLDER_ACCOUNT = 'example';

interface Match { readonly line: number; readonly text: string }
interface Hit extends Match { readonly file: string }

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
}

/** Every tracked text file in scope, by path relative to the repository root. */
function scopeFiles(): string[] {
  return tracked().filter(file => SCOPES.some(scope => (scope.endsWith('/') ? file.startsWith(scope) : file === scope)));
}

function textOf(file: string): string | undefined {
  try {
    const body = readFileSync(join(ROOT, file), 'utf8');
    return body.includes('\0') ? undefined : body;
  } catch { return undefined; }
}

function lineOf(body: string, index: number): number {
  return body.slice(0, index).split('\n').length;
}

function scan(match: (body: string) => Match[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of scopeFiles()) {
    const body = textOf(file);
    if (body !== undefined) hits.push(...match(body).map(hit => ({ ...hit, file })));
  }
  return hits;
}

const listed = (hits: readonly Hit[]): string =>
  hits.map(hit => `${hit.file}:${hit.line}: ${hit.text}`).join('\n');

test('no tracked file carries a real mailbox: every address is documentation, test or a public vendor', () => {
  const hits = scan(body => [...body.matchAll(ADDRESS)].flatMap(match => {
    const address = match[0];
    const domain = address.slice(address.indexOf('@') + 1).toLowerCase();
    if (RESERVED_DOMAIN.test(domain) || VENDOR_DOMAIN.test(domain) || SYNTHETIC_ADDRESSES.has(address)) return [];
    return [{ line: lineOf(body, match.index), text: address }];
  }));
  assert.deepEqual(hits, [], listed(hits));
});

test('no tracked file carries an owner home path: the only account allowed is the documented placeholder', () => {
  const hits = scan(body => [...body.matchAll(HOME_PATH)].flatMap(match => (
    match[1] === PLACEHOLDER_ACCOUNT ? [] : [{ line: lineOf(body, match.index), text: match[0] }]
  )));
  assert.deepEqual(hits, [], listed(hits));
});

test('the guard is not vacuous: it reads the whole shipped tree, not a handful of files', () => {
  const files = scopeFiles();
  assert.ok(files.length > 500, `the guard scanned ${files.length} tracked files`);
  assert.ok(files.includes('server/test/vanilla-tree.test.ts'), 'the guard is itself in scope');
  assert.ok(files.some(file => file.startsWith('scripts/')), 'scripts are in scope');
});
