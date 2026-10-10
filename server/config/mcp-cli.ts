#!/usr/bin/env node
import { initMcpConfiguration, approveMcpConfiguration, disableMcpConfiguration, catalogMcpConfiguration, mcpErrorCode } from './mcp.js';
import { fail } from './files.js';

const help = `MCP configuration (startup intent, not production activation)
node <compiled-root>/config/mcp-cli.js init --config-dir <absolute-new-dir> --owner-id <owner> --profile-input <absolute-private-json> --credential-input <absolute-private-json>
node <compiled-root>/config/mcp-cli.js catalog --config-dir <absolute-dir> --owner-id <owner> --allow-egress --limit <positive-integer> [--cursor <opaque-local-cursor>]
node <compiled-root>/config/mcp-cli.js approve --config-dir <absolute-dir> --data-dir <absolute-host-root> --owner-id <owner> --policy-input <absolute-private-json>
node <compiled-root>/config/mcp-cli.js disable --config-dir <absolute-dir> --data-dir <absolute-host-root> --owner-id <owner>
Bearer tokens are accepted only inside the private credential input file. CLI never opens Store.
`;
const flags: Record<string, { required: string[]; optional: string[] }> = {
  init: { required: ['config-dir', 'owner-id', 'profile-input', 'credential-input'], optional: [] },
  catalog: { required: ['config-dir', 'owner-id', 'allow-egress', 'limit'], optional: ['cursor'] },
  approve: { required: ['config-dir', 'data-dir', 'owner-id', 'policy-input'], optional: [] },
  disable: { required: ['config-dir', 'data-dir', 'owner-id'], optional: [] },
};
async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return; }
  const command = args.shift() ?? ''; const spec = flags[command]; if (!spec) fail('invalid_arguments');
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]?.replace(/^--/, '') ?? '';
    if (args[index] !== `--${key}` || values.has(key) || ![...spec.required, ...spec.optional].includes(key)) fail('invalid_arguments');
    if (key === 'allow-egress') values.set(key, 'true');
    else { const value = args[++index]; if (!value || value.startsWith('--')) fail('invalid_arguments'); values.set(key, value); }
  }
  if (spec.required.some(key => !values.has(key))) fail('invalid_arguments');
  const get = (key: string): string => values.get(key)!;
  const base = { configDir: get('config-dir'), ownerId: get('owner-id') };
  if (command === 'init') {
    initMcpConfiguration({ ...base, profileInput: get('profile-input'), credentialInput: get('credential-input') });
    process.stdout.write('Provisioned disabled; pending host application.\n');
  } else if (command === 'approve') {
    approveMcpConfiguration({ ...base, dataDir: get('data-dir'), policyInput: get('policy-input') });
    process.stdout.write('Provisioned; pending host application.\n');
  } else if (command === 'disable') {
    disableMcpConfiguration({ ...base, dataDir: get('data-dir') });
    process.stdout.write('Disabled locally; durable revocation pending.\n');
  } else {
    if (!/^[1-9][0-9]*$/.test(get('limit'))) fail('invalid_arguments');
    const result = await catalogMcpConfiguration({ ...base, allowEgress: true, limit: Number(get('limit')), ...(values.has('cursor') ? { cursor: get('cursor') } : {}) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
main(process.argv.slice(2)).catch(error => { process.stderr.write(`MCP configuration error: ${mcpErrorCode(error)}\n`); process.exitCode = 1; });
