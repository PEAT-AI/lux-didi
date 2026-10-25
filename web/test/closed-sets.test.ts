import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createSourceFile, forEachChild, isFunctionDeclaration, isReturnStatement, isStringLiteral, ScriptTarget, type Node } from 'typescript';
import { connectorIDs, reasonCodes } from '../src/next-steps.ts';

// The two closed sets must equal what the host emits, so a new id or reason code fails here instead of
// silently landing on the generic failure sentence in front of the owner.
const catalogue = (JSON.parse(readFileSync(new URL('../../server/test/fixtures/installed-mcp-config.json', import.meta.url), 'utf8')) as {
  endpoints: { id: string }[];
}).endpoints;

// W7: the Trello board is the one row the host synthesizes beside the MCP catalogue, from the files alone
// (server/host/runtime.ts:249 builds `{ id: 'trello', connector: 'trello' }`), so it is not an MCP endpoint and
// cannot live in the provider-38 mcp.json the catalogue is read from.
const hostedRows = ['trello'];

test('connectorIDs is exactly the production endpoint catalogue', () => {
  assert.deepEqual([...connectorIDs].sort(), [...catalogue.map(endpoint => endpoint.id), ...hostedRows].sort());
});

/** Every string a return statement in the named function can yield, read from the server source. */
function returnedStrings(file: string, name: string): string[] {
  const source = createSourceFile(file, readFileSync(new URL(`../../server/http/${file}`, import.meta.url), 'utf8'), ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} is declared in ${file}`);
  const codes: string[] = [];
  const walk = (node: Node): void => {
    if (isStringLiteral(node)) { codes.push(node.text); return; }
    forEachChild(node, child => walk(child));
  };
  const returns = (node: Node): void => {
    if (isReturnStatement(node)) { walk(node.expression!); return; }
    forEachChild(node, child => returns(child));
  };
  returns(declaration);
  return [...new Set(codes)].sort();
}

test('reasonCodes is exactly the set connectionReasonCode can return', () => {
  assert.deepEqual(returnedStrings('server.ts', 'connectionReasonCode'), [...reasonCodes].sort());
});
