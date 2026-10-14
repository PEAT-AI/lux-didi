import { loadMcpEndpoints } from '../config/mcp.js';
import { HostLog, captureHostDiagnostics } from './log.js';
import { loadOwnerProfile } from '../config/owner-profile.js';
import { ConfigError, readPrivate, validateRoot } from '../config/files.js';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDomainPort, domainMigrations } from '../domain/index.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { listenService } from '../http/server.js';
import { createStaticHandler } from '../http/static.js';
import { chatMigrations } from '../chat/index.js';
import { liveMigrations } from '../live/index.js';
import { toolsMigrations } from '../tools/index.js';
import { composeChat, type ModelTesting } from './connected.js';
import { composeLive, type LiveTesting } from './live.js';
import { composeMcpRuntime } from './mcp.js';
import type { LiveAuthority, ToolsOwner } from '../tools/types.js';

/** The one migration list the host applies and every Store reopen reuses, so a host-written database never refuses a downgrade. */
export const hostMigrations = [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations];

/** Structural match for W-B's LiveToolsComposition; kept local and additive until its signature lands. */
export type AuthoritySource = (runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>;
export interface LiveToolsComposition {
  owner: ToolsOwner;
  connectionIds(): string[];
  registerAuthoritySource(source: AuthoritySource): void;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
}

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
// Only non-secret catalogs migrate from the installer default, never credentials.
async function seedProviderConfig(dataDir: string, effectiveDir: string, log: HostLog): Promise<void> {
  const defaultDir = join(dataDir, 'provider-config');
  if (effectiveDir === defaultDir) return;
  for (const name of ['live.json', 'mcp.json']) {
    const destination = join(effectiveDir, name);
    try { await lstat(destination); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!validateRoot(defaultDir)) continue;
    let content: string;
    try { content = readPrivate(join(defaultDir, name), 64 * 1024); }
    catch (error) { if (error instanceof ConfigError && error.code === 'file_missing') continue; throw error; }
    await mkdir(effectiveDir, { recursive: true, mode: 0o700 });
    validateRoot(effectiveDir);
    const temporary = join(effectiveDir, `.${name}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      await rename(temporary, destination);
      log.event({ event: 'config_seeded', file: name, from: 'provider-config' });
    } finally { await rm(temporary, { force: true }); }
  }
}
// A descriptor is authority only while it names a live host. Node can prove liveness, not
// direct-child, so a descriptor naming a dead pid (or no readable host) is removed; the
// native supervisor owns the direct-child proof.
function descriptorPid(path: string): { pid?: number } | 'absent' {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) return 'absent';
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? { pid: parsed.pid } : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return {}; // Malformed or unreadable owner-only file: it cannot name a live host.
  }
}
function rmDescriptorQuietly(path: string): void { try { rmSync(path, { force: true }); } catch { /* already gone */ } }
function clearStaleDescriptor(path: string): void {
  const found = descriptorPid(path);
  if (found === 'absent' || found.pid === process.pid) return;
  if (found.pid === undefined) { rmDescriptorQuietly(path); return; }
  try { process.kill(found.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmDescriptorQuietly(path); }
}
function removeOwnDescriptor(path: string): void {
  const found = descriptorPid(path);
  if (found !== 'absent' && found.pid === process.pid) rmDescriptorQuietly(path);
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
  // A crashed predecessor can leave a descriptor naming a dead host. Clear it before this
  // start so a start that also fails leaves no stale descriptor behind.
  clearStaleDescriptor(descriptorPath);
  const log = new HostLog(dataDir);
  let exitLogged = false, exitSignal: NodeJS.Signals | undefined;
  let startupStage = 'log';
  const logExit = (stage: string, reason: 'close' | 'exit'): void => {
    if (exitLogged) return;
    exitLogged = true;
    // Exit logging is best effort: the state directory may already be gone.
    try { log.event({ event: 'host_exit', stage, reason, ...(exitSignal ? { signal: exitSignal } : { code: process.exitCode ?? 0 }) }); } catch { /* nothing durable to write */ }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { exitSignal = signal; });
  process.once('exit', () => { removeOwnDescriptor(descriptorPath); logExit(startupStage, 'exit'); });
  const domain = createDomainPort({ outbox: Outbox }); // No authorized device/target: reminders remain unbound.
  let releaseCommit = 'unknown';
  // Installed service layout is fixed by build-macos-app.sh; source starts have no manifest.
  try {
    const manifest = JSON.parse(await readFile(new URL('../../../../../../didi-runtime.json', import.meta.url), 'utf8'));
    if (typeof manifest.releaseCommit === 'string' && /^[0-9a-f]{40}$/.test(manifest.releaseCommit)) releaseCommit = manifest.releaseCommit;
  } catch { /* Development starts have no installed release metadata. */ }
  const effectiveConfigDir = resolve(config.configDir ?? join(dataDir, 'provider-config'));
  let endpoints = 0;
  let configKind: 'effective' | 'seeded' = config.configDir === undefined ? 'seeded' : 'effective';
  try {
    let selection = loadMcpEndpoints({ configDir: effectiveConfigDir });
    if (selection.state === 'missing') {
      configKind = 'seeded';
      selection = loadMcpEndpoints({ configDir: join(dataDir, 'provider-config') });
    }
    if (selection.state === 'configured') endpoints = selection.catalog.endpoints.length;
  } catch { /* Composition below owns invalid configuration errors. */ }
  log.event({ event: 'host_started', releaseCommit, configDir: configKind, endpoints });
  const stopDiagnostics = captureHostDiagnostics(log);
  let store: Store;
  startupStage = 'store';
  try { store = new Store(dataDir, hostMigrations); } catch (error) { log.error(error); stopDiagnostics(); throw error; }
  try {
    startupStage = 'owner';
    const owner = loadOwnerProfile({ ...(config.ownerProfilePath !== undefined ? { path: config.ownerProfilePath } : {}), ownerId: store.assistantId });
    if (owner.status === 'error') throw new ConfigError('invalid_profile');
    const providerConfigDir = resolve(config.configDir ?? join(dataDir, 'provider-config'));
    await seedProviderConfig(dataDir, providerConfigDir, log);
    // R3: authority is pluggable; sources are consulted in registration order and never fabricated.
    const authoritySources: AuthoritySource[] = [];
    const lookupAuthority: AuthoritySource = async (runId, signal) => {
      for (const source of authoritySources) { const value = await source(runId, signal); if (value) return value; }
      return null;
    };
    const mcp = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir: providerConfigDir, lookupAuthority, log: event => log.event(event) });
    const liveTools: LiveToolsComposition = {
      owner: mcp.owner,
      connectionIds: () => mcp.connectionIds(),
      registerAuthoritySource: source => { authoritySources.push(source); },
      lookupAuthority,
    };
    const { chat, status } = composeChat(store, domain, providerConfigDir, config.modelTesting, config.now, owner.snapshot, liveTools);
    const composeLiveWithTools = composeLive as unknown as (...args: unknown[]) => ReturnType<typeof composeLive>;
    const { service: live } = composeLiveWithTools(store, providerConfigDir, config.liveTesting, config.now, owner.snapshot, liveTools);
    // Observe the actual durable provider settlement, which does not emit console text.
    const attach = live.attach.bind(live);
    live.attach = (...args) => {
      const attachment = attach(...args);
      void attachment.done.then(snapshot => log.terminal(snapshot.terminal), error => log.error(error))
        .catch(() => console.error('diagnostics_unavailable'));
      return attachment;
    };
    startupStage = 'listen';
    const service = await listenService({ store, domain, chat, live, modelStatus: status, ownerProfileStatus: { status: owner.status, displayName: owner.snapshot.displayName }, toolsStatus: () => mcp.status(), webRoot, port, ...(config.now ? { now: config.now } : {}) });
    try {
      const descriptor: RuntimeDescriptor = { schemaVersion: 1, origin: service.origin, authorityEpoch: store.authorityEpoch, assistantId: store.assistantId, pid: process.pid, startedAt: new Date().toISOString() };
      await publish(descriptorPath, descriptor); // Never use a stale descriptor as authority or carry bearer material.
      startupStage = 'ready';
      let closed = false;
      return { store, chat, service, descriptor, descriptorPath, tools: liveTools, async close() {
        if (closed) return; closed = true;
        logExit('ready', 'close');
        removeOwnDescriptor(descriptorPath);
        chat.shutdown();
        try { await service.close(); await live.shutdown(); await mcp.close(); } finally { store.close(); stopDiagnostics(); }
      } };
    } catch (error) { await service.close(); throw error; }
  } catch (error) { log.error(error); stopDiagnostics(); store.close(); throw error; }
}
