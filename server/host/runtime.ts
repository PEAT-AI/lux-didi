import { loadMcpEndpoints } from '../config/mcp.js';
import { isCustomVoiceId } from '../adapters/live-voice/openai.js';
import { HostLog, captureHostDiagnostics } from './log.js';
import { configureDebugJournal } from './journal.js';
import { supervisionRequested } from './supervision.js';
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
import type { WarmPrewarmReceipt } from '../live/index.js';
import { toolsMigrations } from '../tools/index.js';
import { composeChat, type ModelTesting } from './connected.js';
import { composeLive, type LiveTesting } from './live.js';
import { composeMcpRuntime } from './mcp.js';
import type { McpRuntimeComposition } from './mcp.js';
import { buildCalendarDigest, createGoogleReader } from '../connectors/google.js';
import { loadProviderConfig } from '../config/index.js';
import { GeminiAdapter } from '../adapters/model/index.js';
import { createSummarizer } from '../services/summarize.js';
import type { LiveAuthority, ToolsOwner } from '../tools/types.js';

/** The one migration list the host applies and every Store reopen reuses, so a host-written database never refuses a downgrade. */
export const hostMigrations = [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations];

/** Structural match for W-B's LiveToolsComposition; kept local and additive until its signature lands. */
export type AuthoritySource = (runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>;
export interface LiveToolsComposition {
  owner: ToolsOwner;
  connectionIds(): string[];
  status?(): { endpoints: readonly { id: string; connector: string; state: string }[] };
  registerAuthoritySource(source: AuthoritySource): void;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
  /** 339: today's calendar digest for the warm context; absent leaves the slot out. */
  calendarDigest?(): Promise<string | undefined>;
}

export interface HostConfig { dataDir: string; webRoot: string; port?: number; descriptor?: string; configDir?: string; ownerProfilePath?: string; modelTesting?: ModelTesting; liveTesting?: LiveTesting; now?: () => number; deferConnectors?: boolean; supervised?: boolean }

/**
 * The warm context's calendar digest (issue 339): one bounded read of today's primary calendar through
 * the owner's configured google connector, in the host's own time zone. Without a current calendar
 * grant there is no reader and the slot stays absent, so a session start is never failed by it.
 */
async function warmCalendarDigest(mcp: McpRuntimeComposition, now: () => number): Promise<string | undefined> {
  const endpoint = mcp.status().endpoints.find(entry => entry.connector === 'google');
  const grant = endpoint === undefined ? undefined : mcp.registry.currentGrant(endpoint.id);
  if (grant === undefined || !grant.toolNames.includes('gcal_list')) return undefined;
  const reader = createGoogleReader({ port: mcp.port, registry: mcp.registry,
    config: { endpointId: grant.endpointId, account: grant.account, resource: grant.resource, schemaDigest: grant.schemaDigest, generation: grant.generation, family: 'calendar' } });
  return await buildCalendarDigest(reader, { now: now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}
export function defaultDataDir(): string {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Lux Didi');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Lux Didi');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'lux-didi');
}
/** The installed app's per-user application support folder: its own state and provider config live here. */
export function installedAppFolder(): string { return join(homedir(), 'Library', 'Application Support', 'ai.peat.lux-didi'); }
/**
 * #397: one loud line when a host outside the installed app would take the installed app's own config dir.
 * The supervised host the app itself spawns is the one exception; every other start is told the flag that
 * gives it a state of its own. Undefined means the start may proceed.
 */
export function installedConfigDirRefusal(configDir: string, supervised: boolean): string | undefined {
  if (supervised) return undefined;
  const installed = installedAppFolder();
  if (configDir !== installed && !configDir.startsWith(installed + sep)) return undefined;
  return `Refusing --config-dir ${configDir}: it is the installed app's own folder, which only the app's supervised host may open; run this host with --data-dir <your own state folder> and copy the provider config there instead.`;
}
/** The app's own supervision marker (server/host/supervision.ts) decides the one exception to the refusal. */
function supervisedHost(config: HostConfig): boolean { return config.supervised ?? supervisionRequested(); }
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
  // #397: another installation's folder is not this host's config source. Only the app's own supervised
  // host may open its folder; every other start gets one loud line and exits before any state is created.
  const refused = installedConfigDirRefusal(effectiveConfigDir, supervisedHost(config));
  if (refused) throw new Error(refused);
  // The debug journal is rooted at this host's own --data-dir, never beside the --config-dir it was handed;
  // the live config keeps this root once it is installed here.
  configureDebugJournal(dataDir, true);
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
    const mcp = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir: providerConfigDir, lookupAuthority, deferConnectors: config.deferConnectors === true, log: event => log.event(event), connectorLog: (connector, stage, detail) => log.event({ event: 'connector_failure', connector, stage, ...(detail ?? {}) }), identityLog: (connector, proven, match) => log.event({ event: 'connector_identity', connector, proven, match }) });
    // Session memory v1: one async distillation per ended Live session, plus the host-start reconciler.
    // The distiller reuses the text model the provider config already names for chat and tools.
    const providerLoaded = loadProviderConfig({ configDir: providerConfigDir, ownerId: store.assistantId });
    let summaryModel: GeminiAdapter | null = null;
    let summaryModelId: string | null = null;
    if (providerLoaded.status === 'ready') {
      summaryModelId = providerLoaded.profile.modelId;
      try { summaryModel = new GeminiAdapter({ modelId: providerLoaded.profile.modelId, keyReference: providerLoaded.profile.keyReference,
        route: providerLoaded.route, credentials: config.modelTesting?.credentials ?? providerLoaded.credentials,
        ...(config.modelTesting?.transport ? { transport: config.modelTesting.transport } : {}) }); }
      catch { summaryModel = null; }
    }
    const summarizer = createSummarizer({ store, model: summaryModel, modelId: summaryModelId ?? 'unconfigured',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: config.now ?? Date.now, log: event => log.event(event) });
    const liveTools: LiveToolsComposition & { onSessionTerminal?: (liveSessionId: string) => void; log?: (event: { event: string } & Record<string, unknown>) => void } = {
      owner: mcp.owner,
      connectionIds: () => mcp.connectionIds(),
      status: () => mcp.status(),
      registerAuthoritySource: source => { authoritySources.push(source); },
      lookupAuthority,
      calendarDigest: () => warmCalendarDigest(mcp, config.now ?? Date.now),
      onSessionTerminal: liveSessionId => summarizer.schedule(liveSessionId),
      log: event => log.event(event),
    };
    const { chat, status } = composeChat(store, domain, providerConfigDir, config.modelTesting, config.now, owner.snapshot, liveTools);
    const composeLiveWithTools = composeLive as unknown as (...args: unknown[]) => ReturnType<typeof composeLive>;
    const { service: live } = composeLiveWithTools(store, providerConfigDir, config.liveTesting, config.now, owner.snapshot, liveTools);
    // The live service carries the owner's prewarm instruction; an unconfigured live keeps the quiet receipt.
    const warmOwner = live as typeof live & { prewarm?: () => Promise<WarmPrewarmReceipt> };
    // The names a call will use, on the start event: a log alone then proves which provider, model and
    // voice served it. The status projection carries no key, reference or prompt.
    const liveNow = live.status();
    if (liveNow.status === 'configured' && liveNow.provider !== undefined && liveNow.model !== undefined && liveNow.voice !== undefined) {
      log.event({ event: 'live_started', provider: liveNow.provider, modelId: liveNow.model, voice: liveNow.voice,
        voiceKind: isCustomVoiceId(liveNow.voice) ? 'custom' : 'preset' });
    }
    void summarizer.reconcile().catch(error => log.error(error));
    void summarizer.requeueFailed().catch(error => log.error(error));
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
      return { store, chat, service, descriptor, descriptorPath, tools: liveTools,
        // 338: the owner's wake instruction, the same one POST api/v1/live/prewarm serves. The live
        // owner writes the one closed `warm_prewarm` line, so either route logs it exactly once.
        prewarm: async (): Promise<WarmPrewarmReceipt> =>
          await warmOwner.prewarm?.() ?? { ageBeforeMs: null, ageAfterMs: null, assembled: false },
        start: () => mcp.start(), async close() {
        if (closed) return; closed = true;
        logExit('ready', 'close');
        removeOwnDescriptor(descriptorPath);
        chat.shutdown();
        try { await service.close(); await live.shutdown(); await mcp.close(); } finally { store.close(); stopDiagnostics(); }
      } };
    } catch (error) { await service.close(); throw error; }
  } catch (error) { log.error(error); stopDiagnostics(); store.close(); throw error; }
}
