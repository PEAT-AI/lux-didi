import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

// The lookup line is a pure projection of the live entries, so run it straight from main.ts.
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

const entry = (progress: Record<string, unknown>) => ({ seq: 1, kind: 'researchProgress', progress });
const liveWith = (entries: unknown[]) => ({ state: 'thinking', since: 's', cursor: 9, entries });

test('the lookup line names the sources and checks each one that is done', () => {
  const markup = lookupLine(liveWith([entry({ researchId: 'r1', phase: 'round', sourcesDone: ['calendar'], sourcesPending: ['mail'], elapsedMs: 1200 })]));
  assert.match(markup, /class="lookup-line"/);
  assert.match(markup, /Looking in/);
  assert.doesNotMatch(markup, /Still looking/);
  assert.match(markup, /<span class="lookup-source lookup-source-done"><span class="lookup-check" aria-hidden="true">&#10003;<\/span>calendar<\/span>/);
  assert.match(markup, /<span class="lookup-source">mail<\/span>/);
});

test('a lookup past six seconds says it is still looking', () => {
  const markup = lookupLine(liveWith([entry({ researchId: 'r1', phase: 'started', sourcesDone: [], sourcesPending: ['calendar', 'mail'], elapsedMs: 6000 })]));
  assert.equal(markup.replace(/<[^>]*>/g, ''), 'Still looking in calendar, mail');
});

test('the line clears on done and on stopped', () => {
  assert.equal(lookupLine(liveWith([entry({ researchId: 'r1', phase: 'done', sourcesDone: ['calendar', 'mail'], sourcesPending: [], elapsedMs: 7000 })])), '');
  assert.equal(lookupLine(liveWith([entry({ researchId: 'r1', phase: 'stopped', sourcesDone: [], sourcesPending: ['calendar'], elapsedMs: 800 })])), '');
  assert.equal(lookupLine(liveWith([])), '');
});

test('only the source kinds and phase reach the line, never the question or results', () => {
  const markup = lookupLine(liveWith([entry({ researchId: 'r1', phase: 'round', sourcesDone: ['calendar'], sourcesPending: ['mail'], elapsedMs: 500, question: 'what is on my calendar', results: 'Standup at nine' })]));
  assert.doesNotMatch(markup, /what is on my calendar/);
  assert.doesNotMatch(markup, /Standup at nine/);
  assert.doesNotMatch(markup, /question|results/);
});
