import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TRELLO_ACTIONS, trelloRequests, trelloSchemas } from '../adapters/trello/client.js';

/**
 * The Trello transport contract: every REST request the adapter can build is checked against Atlassian's
 * published OpenAPI document, committed byte for byte under fixtures/specs/ with its retrieval URL and date.
 * A hand written copy of the vendor's schema is what let release 8 call a route Trello does not publish, so
 * the source of truth here is the vendor's own file and the sha256 below fails if it is edited.
 */

interface SpecOperation {
  parameters?: { name: string; in: string; required?: boolean }[];
}
interface Spec {
  openapi: string;
  info: { title: string };
  paths: Record<string, (SpecOperation & Record<string, unknown>)>;
}
interface Source {
  file: string;
  retrieved_url: string;
  retrieved_at: string;
  sha256: string;
}

const specBytes = readFileSync(new URL('../../test/fixtures/specs/trello-openapi.json', import.meta.url));
const source = JSON.parse(String(readFileSync(new URL('../../test/fixtures/specs/trello-openapi.source.json', import.meta.url)))) as Source;
const spec = JSON.parse(String(specBytes)) as Spec;

/** One value per declared argument, so every branch of the request builder is reached with a real shape. */
const argValue = (prop: string): string => `synthetic-${prop}`;

const template = (path: string): string[] => path.split('/').filter(segment => segment.length > 0);

/** The segment match Trello's paths allow: a literal, or a `{param}` that stands for one non-empty segment. */
function matches(specPath: string, requestPath: string): boolean {
  const left = template(specPath);
  const right = template(requestPath);
  if (left.length !== right.length) return false;
  return left.every((segment, index) => (/^\{[^}]+\}$/u.test(segment) ? right[index]!.length > 0 : segment === right[index]));
}

/** The published operation for one request path and method, or the reason there is none. */
function operationFor(path: string, method: string): { template: string; operation: SpecOperation } | undefined {
  const candidates = Object.keys(spec.paths).filter(candidate => matches(candidate, path));
  const match = candidates.find(candidate => (spec.paths[candidate]![method.toLowerCase()] as SpecOperation | undefined) !== undefined);
  if (match === undefined) return undefined;
  return { template: match, operation: spec.paths[match]![method.toLowerCase()] as SpecOperation };
}

test('the pinned Trello spec is the vendor published document, unmodified', () => {
  assert.equal(createHash('sha256').update(specBytes).digest('hex'), source.sha256, 'the committed spec is byte for byte the published document, so a local edit cannot move the source of truth');
  assert.equal(source.file, 'trello-openapi.json');
  assert.match(source.retrieved_url, /^https:\/\/[a-z.]*atlassian\.com\/.+swagger\.v3\.json$/u, 'the retrieval URL is Atlassian publishing its own document');
  assert.match(source.retrieved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u, 'the sidecar names the day the bytes were retrieved');
  assert.equal(spec.info.title, 'Trello REST API');
  assert.equal(spec.openapi.startsWith('3.'), true);
  assert.ok(Object.keys(spec.paths).length > 100, 'the whole published paths object, not an extract');
});

test('every Trello action the adapter can build is a route Atlassian publishes, with its required parameters', () => {
  // The registry is the adapter's own table: a new action cannot skip this test, because it appears here.
  const actions = Object.entries(TRELLO_ACTIONS).flatMap(([tool, table]) => Object.keys(table).map(action => ({ tool, action })));
  const advertised = trelloSchemas().flatMap(entry => {
    const schema = entry.inputSchema as { properties: { action: { oneOf: readonly { properties: { action: { const: string } } }[] } } };
    return schema.properties.action.oneOf.map(branch => branch.properties.action.const);
  });
  assert.equal(advertised.length, actions.length, 'the advertised action table and the tested action table are the same set');
  assert.ok(actions.length >= 20, `the adapter builds every documented action (${actions.length} found)`);

  for (const { tool, action } of actions) {
    const props = TRELLO_ACTIONS[tool]![action]!;
    const built = trelloRequests(tool, { action, ...Object.fromEntries(props.map(prop => [prop, argValue(prop)])) });
    assert.ok(built !== undefined, `${tool}.${action} builds a request from its own declared fields`);
    for (const request of built.requests) {
      const found = operationFor(request.path, request.method);
      assert.ok(found !== undefined, `${tool}.${action} calls ${request.method} /1/${request.path}, which Trello publishes`);
      const required = [...(spec.paths[found.template]!.parameters ?? []), ...(found.operation.parameters ?? [])].filter(param => param.required === true);
      for (const param of required) {
        if (param.in === 'path') continue; // A matched template supplies every path parameter by construction.
        const supplied = request.query?.[param.name] ?? request.body?.[param.name];
        assert.ok(supplied !== undefined, `${tool}.${action} supplies ${param.name}, which ${request.method} /1/${found.template} requires`);
      }
    }
  }
});
