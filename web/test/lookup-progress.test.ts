import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

// The lookup subtitle is a pure projection of the live entries, so run it straight from main.ts.
// main.ts has module side effects, so the source block alone is transpiled and run in a bare vm.
function lookupLine(live: unknown): string {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const LOOKUP_SOURCE_WORDS');
  const end = source.indexOf('function orbCaptionMarkup()');
  assert.ok(start >= 0 && end > start, 'the lookup line source lives in main.ts');
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const context: Record<string, unknown> = {};
  createContext(context);
  runInContext(js, context);
  return (context['lookupLineMarkup'] as (value: unknown) => string)(live);
}

const progress = (fields: Record<string, unknown>) => ({ seq: 1, kind: 'researchProgress', progress: { researchId: 'r1', ...fields } });
const liveWith = (entries: unknown[]) => ({ state: 'listening', since: 's', cursor: 9, entries });
const plain = (markup: string) => markup.replace(/<[^>]*>/g, '');

test('the subtitle names the sources and checks each one that is done, no space before commas', () => {
  const markup = lookupLine(liveWith([progress({ phase: 'round', sourcesDone: ['calendar'], sourcesPending: ['mail', 'lux'], elapsedMs: 1200 })]));
  assert.equal(plain(markup), 'Looking in calendar &#10003;, mail, lux');
  assert.match(markup, /calendar <span class="lookup-check" aria-hidden="true">&#10003;<\/span>, mail, lux/);
});

test('the source names match the chat lane wording', () => {
  const markup = lookupLine(liveWith([progress({ phase: 'started', sourcesDone: [], sourcesPending: ['calendar', 'mail', 'chat', 'knowledge'], elapsedMs: 0 })]));
  assert.equal(plain(markup), 'Looking in calendar, mail, Mattermost, lux');
});

test('a lookup past six seconds says it is still looking', () => {
  const markup = lookupLine(liveWith([progress({ phase: 'started', sourcesDone: [], sourcesPending: ['calendar', 'mail'], elapsedMs: 6000 })]));
  assert.equal(plain(markup), 'Still looking');
});

test('the subtitle clears on done and on stopped', () => {
  assert.equal(lookupLine(liveWith([progress({ phase: 'done', sourcesDone: ['calendar', 'mail'], sourcesPending: [], elapsedMs: 7000 })])), '');
  assert.equal(lookupLine(liveWith([progress({ phase: 'stopped', sourcesDone: [], sourcesPending: ['calendar'], elapsedMs: 800 })])), '');
  assert.equal(lookupLine(liveWith([])), '');
});

test('only the source kinds and phase reach the line, never the question or results', () => {
  const markup = lookupLine(liveWith([progress({ phase: 'round', sourcesDone: ['calendar'], sourcesPending: ['mail'], elapsedMs: 500, question: 'what is on my calendar', results: 'Standup at nine' })]));
  assert.doesNotMatch(markup, /what is on my calendar/);
  assert.doesNotMatch(markup, /Standup at nine/);
  assert.doesNotMatch(markup, /question|results/);
});
