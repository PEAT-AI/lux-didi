import { loadOwnerProfile } from '../config/owner-profile.js';
import { ConfigError } from '../config/files.js';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDomainPort } from '../domain/index.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { listenService } from '../http/server.js';
import { createStaticHandler } from '../http/static.js';
import { chatMigrations } from '../chat/index.js';
import { liveMigrations } from '../live/index.js';
import { composeChat, type ModelTesting, type ToolChatAssembly } from './connected.js';
import { composeLive, type LiveTesting } from './live.js';
import { composeMcpConnection } from './mcp.js';
import { McpRegistry } from '../adapters/mcp/registry.js';
import { createMcpAdapter } from '../adapters/mcp/adapter.js';
import { MemoryResultStore } from '../adapters/mcp/store.js';
import { loadMcpConfiguration } from '../config/mcp.js';

export interface HostConfig { dataDir: string; webRoot: string; port?: number; descriptor?: string; configDir?: string; ownerProfilePath?: string; modelTesting?: ModelTesting; liveTesting?: LiveTesting; now?: () => number }
export function defaultDataDir(): string {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Lux Didi');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Lux Didi');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'lux-didi');
}
export interface RuntimeDescriptor {
  schemaVersion: 1; origin: string; authorityEpoch: string; assistantId: string; pid: number; startedAt: string;
}
export async function pairLocal(dataDir: string, descriptorPath = join(dataDir, 'host-runtime.json')): Promise<string> {
  for (const path of [descriptorPath, join(dataDir, 'admin-credential')]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) throw new Error('Pairing requires existing owner-only runtime files');
  }
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as RuntimeDescriptor;
  if (descriptor.schemaVersion !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.origin)) throw new Error('Invalid local runtime descriptor');
  const origin = new URL(descriptor.origin).origin;
  const credential = (await readFile(join(dataDir, 'admin-credential'), 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('Invalid local admin credential');
  const headers = { Authorization: `Bearer ${credential}` };
  const status = await fetch(`${origin}/api/v1/status`, { headers, signal: AbortSignal.timeout(3000) });
  if (!status.ok) throw new Error('Current service identity unavailable');
  const { data } = await status.json();
  if (data.authorityEpoch !== descriptor.authorityEpoch || data.assistantId !== descriptor.assistantId || data.serviceMode !== 'loopback') throw new Error('Runtime descriptor does not match current service identity');
  const response = await fetch(`${origin}/api/v1/auth/pairing`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Browser pairing unavailable');
  const pairing = await response.json();
  if (typeof pairing.data?.pairingCode !== 'string') throw new Error('Invalid browser pairing response');
  return pairing.data.pairingCode;
}
async function publish(path: string, descriptor: RuntimeDescriptor): Promise<void> {
  const directory = resolve(path, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('Runtime descriptor must be a regular file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(descriptor)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function startHost(config: HostConfig) {
  const dataDir = resolve(config.dataDir), webRoot = resolve(config.webRoot);
  const port = config.port ?? 8765;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port');
  if (dataDir === webRoot) throw new Error('Web build and state must be separate directories');
  // Invalid web configuration must not create/open a database or leave a listener.
  await createStaticHandler(webRoot);
  const descriptorPath = resolve(config.descriptor ?? join(dataDir, 'host-runtime.json'));
  const descriptorRelative = relative(webRoot, descriptorPath);
  if (!descriptorPath.endsWith('.json') || (!isAbsolute(descriptorRelative) && descriptorRelative !== '..' && !descriptorRelative.startsWith(`..${sep}`))) throw new Error('Descriptor must be a JSON file outside the web build');
  const domain = createDomainPort({ outbox: Outbox }); // No authorized device/target: reminders remain unbound.
  const store = new Store(dataDir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
  try {
    const owner = loadOwnerProfile({ ...(config.ownerProfilePath !== undefined ? { path: config.ownerProfilePath } : {}), ownerId: store.assistantId });
    if (owner.status === 'error') throw new ConfigError('invalid_profile');
    const providerConfigDir = resolve(config.configDir ?? join(dataDir, 'provider-config'));
    // Trusted host composition: the actual MCP registry/MCP HTTP port and the accepted
    // owner are built here (not CLI/HTTP/env). Missing or refused configuration means
    // text-only turns; an unconfigured optional connection never blocks app launch.
    const mcpConfigDir = resolve(join(providerConfigDir, 'mcp'));
    const registry = new McpRegistry();
    const port = createMcpAdapter({ registry, store: new MemoryResultStore({ maxBytes: 16384, maxEntries: 8, ttlMs: 300000, maxSliceBytes: 4096 }),
      resolveCredential: async (reference: string) => loadMcpConfiguration({ configDir: mcpConfigDir, ownerId: store.assistantId, dataDir }).resolveCredential(reference),
      budgets: { timeoutMs: 8000, maxResponseBytes: 16384, maxPages: 4, maxTools: 32, projectionChars: 4096 } });
    const assembly: ToolChatAssembly = { registry, port, connections: [] };
    const { chat, status, tools } = composeChat(store, domain, providerConfigDir, config.modelTesting, config.now, owner.snapshot, assembly);
    if (tools) composeMcpConnection({ store, owner: tools, registry, configDir: mcpConfigDir });
    const { service: live } = composeLive(store, providerConfigDir, config.liveTesting, config.now, owner.snapshot);
    const service = await listenService({ store, domain, chat, live, modelStatus: status, ownerProfileStatus: { status: owner.status, displayName: owner.snapshot.displayName }, webRoot, port, ...(config.now ? { now: config.now } : {}) });
    try {
      const descriptor: RuntimeDescriptor = { schemaVersion: 1, origin: service.origin, authorityEpoch: store.authorityEpoch, assistantId: store.assistantId, pid: process.pid, startedAt: new Date().toISOString() };
      await publish(descriptorPath, descriptor); // Never use a stale descriptor as authority or carry bearer material.
      let closed = false;
      return { store, chat, service, descriptor, descriptorPath, async close() {
        if (closed) return; closed = true;
        chat.shutdown();
        try { await service.close(); await live.shutdown(); } finally { store.close(); }
      } };
    } catch (error) { await service.close(); throw error; }
  } catch (error) { store.close(); throw error; }
}
