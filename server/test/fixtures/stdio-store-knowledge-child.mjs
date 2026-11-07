// Synthetic local protocol fixture, no network, credentials or corpus.
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const sdk = new Server({ name: 'synthetic-store-knowledge', version: '1' }, { capabilities: { tools: {} } });
// M21-R2: the lux daemon's next release (LK5) declares every read tool with readOnlyHint true, and
// that annotation is the whole admission, so the fixture publishes the same shape.
sdk.setRequestHandler('tools/list', () => ({ tools: [
  { name: 'search_knowledge', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' }, include_sensitive: { type: 'boolean' } } } },
  { name: 'get_insight', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'integer' } }, include_links: { type: 'boolean' } } } },
] }));
sdk.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: '# Synthetic knowledge\n\nPublic fixture result, no private corpus.' }] }));
await sdk.connect(new StdioServerTransport());
