import { boundTextModel } from './provider-binding.js';
import { loadMcpEndpoints } from '../config/mcp.js';
import { isCustomVoiceId } from '../adapters/live-voice/openai.js';
import { HostLog, captureHostDiagnostics } from './log.js';
import { supervisionRequested } from './supervision.js';
import { loadOwnerProfile } from '../config/owner-profile.js';
import { ConfigError, readPrivate, validateRoot } from '../config/files.js';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDomainPort, domainMigrations } from '../domain/index.js';
import { Outbox } from '../runtime/outbox.js';
import { Store } from '../runtime/store.js';
import { listenService } from '../http/server.js';
import { createStaticHandler } from '../http/static.js';
import { chatMigrations } from '../chat/index.js';
import { liveMigrations } from '../live/index.js';
import type { CalendarDigestOwner, WarmPrewarmReceipt } from '../live/index.js';
import { toolsMigrations } from '../tools/index.js';
import { composeChat, type ModelTesting } from './connected.js';
import { composeLive, type LiveTesting } from './live.js';
import { composeMcpRuntime, type ConnectorLifecycleEvent } from './mcp.js';
import { spawn } from 'node:child_process';
import { MongooseLoginError, runMongooseLogin } from './mongoose-login.js';
import type { McpRuntimeComposition } from './mcp.js';
import { createGoogleReader, readCalendarDigest, type CalendarDigestRead } from '../connectors/google.js';
import { CalendarDigestCache } from '../live/warm-context.js';
import { loadProviderConfig } from '../config/index.js';
import { createSummarizer } from '../services/summarize.js';
import type { LiveAuthority, ToolsOwner } from '../tools/types.js';

/** The one migration list the host applies and every Store reopen reuses, so a host-written database never refuses a downgrade. */
export const hostMigrations = [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations];

/** Structural match for W-B's LiveToolsComposition; kept local and additive until its signature lands. */
export type AuthoritySource = (runId: string, signal: AbortSignal) => Promise<LiveAuthority | null>;

/** One owner click runs the same sign-in the CLI flag runs, and the connector reconnects when it lands. */
export type MongooseSignIn = () => Promise<{ status: 'started'; url: string } | { status: 'failed'; reason: string }>;

/** Opens the owner's default browser; the web view never opens one by itself. */
export function openInDefaultBrowser(url: string): void {
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
}
export interface LiveToolsComposition {
  recover?(): Promise<void>;
  owner: ToolsOwner;
  connectionIds(): string[];
  status?(): { endpoints: readonly { id: string; connector: string; state: string }[] };
  registerAuthoritySource(source: AuthoritySource): void;
  lookupAuthority(runId: string, signal: AbortSignal): Promise<LiveAuthority | null>;
  /** 339, 1015: today's calendar digest for the warm context; absent leaves the slot out. */
  calendarDigest?: CalendarDigestOwner;
}

/**
 * The one click path: resolve the configured mongoose endpoint, run the same login the CLI flag runs, and
 * reconnect the connector once the record lands. Every failure is a closed code, never free text.
 */
export function createMongooseSignIn(options: { configDir: string; recover: () => Promise<void>; open?: (url: string) => void }): MongooseSignIn {
  const open = options.open ?? openInDefaultBrowser;
  let pending: Promise<{ status: 'started'; url: string } | { status: 'failed'; reason: string }> | undefined;
  return () => {
    if (pending) return pending;
    const selection = loadMcpEndpoints({ configDir: options.configDir });
    const entry = selection.state === 'configured'
      ? selection.catalog.endpoints.find(candidate => candidate.connector === 'mongoose' && candidate.transport !== 'stdio' && candidate.credentialRef && candidate.url)
      : undefined;
    if (!entry || entry.transport === 'stdio' || !entry.credentialRef || !entry.url) return Promise.resolve({ status: 'failed' as const, reason: 'not-configured' });
    let release: (value: { status: 'started'; url: string } | { status: 'failed'; reason: string }) => void = () => {};
    let failure: string | undefined;
    const first = new Promise<{ status: 'started'; url: string } | { status: 'failed'; reason: string }>(resolve => { release = resolve; });
    pending = first;
    void runMongooseLogin({ configDir: options.configDir, reference: entry.credentialRef, resourceUrl: entry.url, account: entry.account,
      showAuthorizationUrl: (url: string) => { open(url); release({ status: 'started', url }); } })
      .then(() => options.recover())
      .catch((error: unknown) => { failure = error instanceof MongooseLoginError ? error.code : 'sign-in-did-not-finish'; })
      .finally(() => {
        pending = undefined;
        // Only a login that never reached the browser settles here unanswered, and it settles named.
        release({ status: 'failed', reason: failure ?? 'sign-in-did-not-finish' });
      });
    return first;
  };
}

/**
 * The host's connector lifecycle sink: the closed line goes to host.log, and a recovery owes one
 * follow-up, a re-read of whatever that connector feeds.
 */
export function connectorLifecycleSink(input: {
  log: (event: ConnectorLifecycleEvent) => void;
  onRecovered: (endpointId: string) => void;
  onConnected?: (endpointId: string) => void;
}): (event: ConnectorLifecycleEvent) => void {
  return event => {
    input.log(event);
    if (event.event === 'connector_recovered') input.onRecovered(event.endpointId);
    if (event.event === 'connector_connected') input.onConnected?.(event.endpointId);
  };
}

/** L2: why the digest was read again, as a closed set, so host.log can say which edge moved it. */
export type CalendarDigestRefreshReason = 'start' | 'timer' | 'recovered' | 'first_connect';
export type CalendarDigestRefreshLog = (event: { event: 'calendar_digest_refreshed'; reason: CalendarDigestRefreshReason; ms: number }) => void;

/** One measured digest read off every request path: the reason it ran and how long it took, never content. */
async function refreshDigestOnce(input: {
  digest: { refresh(): Promise<unknown> };
  reason: CalendarDigestRefreshReason;
  now: () => number;
  log?: CalendarDigestRefreshLog | undefined;
}): Promise<void> {
  const started = input.now();
  try { await input.digest.refresh(); } catch { return; }
  input.log?.({ event: 'calendar_digest_refreshed', reason: input.reason, ms: Math.max(0, input.now() - started) });
}

/**
 * L2: the digest read that host start raced used to stay absent until the 15 minute timer, so the first
 * call of a run had no calendar. The first `connector_connected` of a calendar endpoint re-reads it once
 * when what the cache holds is not a completed read from after the start. Same reader, same budget, and
 * never on a request path.
 */
export function bindCalendarFirstConnect(input: {
  digest: { forStart(): Promise<{ state: string; fetchedAt: number }>; refresh(): Promise<unknown> } | undefined;
  endpoints: () => readonly { readonly id: string; readonly connector: string }[];
  grantOf: (endpointId: string) => { readonly toolNames: readonly string[]; readonly endpointId: string } | undefined;
  startedAt: number;
  now: () => number;
  log: CalendarDigestRefreshLog;
}): (endpointId: string) => void {
  let owed = true;
  return endpointId => {
    const digest = input.digest;
    if (digest === undefined || !owed) return;
    const grant = selectCalendarEndpoint(input.endpoints(), input.grantOf);
    if (grant === undefined || grant.endpointId !== endpointId) return;
    owed = false;
    void digest.forStart().then(snapshot => {
      if (snapshot.state === 'present' && snapshot.fetchedAt >= input.startedAt) return undefined;
      return refreshDigestOnce({ digest, reason: 'first_connect', now: input.now, log: input.log });
    }, () => undefined);
  };
}

/** L12d: how often a live call reports its own process resources, and the closed window a read covers. */
export const hostResourceIntervalMs = 60_000;

/**
 * L12d: one process resource receipt per window while a call is live. Memory and CPU are read here, on a
 * timer, so nothing is measured on an audio or model path; `cpuPct` is the CPU time this process used over
 * the window that just ended, as a percentage of one core.
 */
export function createHostResourceSampler(input: {
  log: (event: { event: 'host_resources'; rssMb: number; heapUsedMb: number; cpuPct: number }) => void;
  now: () => number;
  memoryUsage?: () => { rss: number; heapUsed: number };
  cpuUsage?: () => { user: number; system: number };
  intervalMs?: number;
}): { sample: () => boolean; begin: () => () => void } {
  const intervalMs = input.intervalMs ?? hostResourceIntervalMs;
  const memory = input.memoryUsage ?? (() => process.memoryUsage());
  const cpu = input.cpuUsage ?? (() => process.cpuUsage());
  let windowStart: number | undefined;
  let cpuStart = cpu();
  const round = (value: number): number => Math.round(value * 10) / 10;
  const sample = (): boolean => {
    const at = input.now();
    const started = windowStart;
    if (started === undefined) { windowStart = at; cpuStart = cpu(); return false; }
    const elapsed = at - started;
    if (elapsed < intervalMs) return false;
    const used = cpu();
    const cpuMs = (used.user - cpuStart.user) + (used.system - cpuStart.system);
    const mem = memory();
    windowStart = at;
    cpuStart = used;
    input.log({ event: 'host_resources',
      rssMb: round(mem.rss / 1_048_576), heapUsedMb: round(mem.heapUsed / 1_048_576),
      cpuPct: round((cpuMs / elapsed) * 100) });
    return true;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    sample,
    begin: () => {
      windowStart = input.now();
      cpuStart = cpu();
      const interval = setInterval(sample, intervalMs);
      interval.unref();
      timer = interval;
      return () => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
    },
  };
}

/**
 * Which recovery re-reads the calendar digest: only the endpoint whose current grant carries the calendar
 * tool. A mail endpoint of the same account recovering says nothing about the calendar.
 */
export function bindCalendarRecovery<G extends { readonly toolNames: readonly string[]; readonly endpointId: string }>(input: {
  digest: { refresh(): Promise<unknown> } | undefined;
  endpoints: () => readonly { readonly id: string; readonly connector: string }[];
  grantOf: (endpointId: string) => G | undefined;
  now?: () => number;
  log?: CalendarDigestRefreshLog | undefined;
}): (endpointId: string) => void {
  return endpointId => {
    const digest = input.digest;
    if (digest === undefined) return;
    const grant = selectCalendarEndpoint(input.endpoints(), input.grantOf);
    if (grant !== undefined && grant.endpointId === endpointId) {
      void refreshDigestOnce({ digest, reason: 'recovered', now: input.now ?? Date.now, log: input.log });
    }
  };
}

export interface HostConfig { dataDir: string; webRoot: string; port?: number; descriptor?: string; configDir?: string; ownerProfilePath?: string; modelTesting?: ModelTesting; liveTesting?: LiveTesting; now?: () => number; deferConnectors?: boolean; supervised?: boolean }

/**
 * R7: mail and calendar are both `connector: google`, so the first google endpoint is not necessarily the
 * calendar endpoint. The digest reads the endpoint whose current grant carries `calendar_list_events`; without one
 * there is no reader and the digest says so rather than reporting an empty day.
 */
export function selectCalendarEndpoint<G extends { readonly toolNames: readonly string[] }>(endpoints: readonly { readonly id: string; readonly connector: string }[], grantOf: (endpointId: string) => G | undefined): G | undefined {
  for (const endpoint of endpoints) {
    if (endpoint.connector !== 'google') continue;
    const grant = grantOf(endpoint.id);
    if (grant !== undefined && grant.toolNames.includes('calendar_list_events')) return grant;
  }
  return undefined;
}
/**
 * One digest read for the host's cache (1015): the reader the owner's grant allows, or nothing when the
 * connector is not granted, which the read reports as `unconfigured`.
 */
function calendarDigestReader(mcp: McpRuntimeComposition): CalendarDigestRead | undefined {
  const grant = selectCalendarEndpoint(mcp.status().endpoints, id => mcp.registry.currentGrant(id));
  if (grant === undefined) return undefined;
  return createGoogleReader({ port: mcp.port, registry: mcp.registry,
    config: { endpointId: grant.endpointId, account: grant.account, resource: grant.resource, schemaDigest: grant.schemaDigest, generation: grant.generation, family: 'calendar' } });
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

/**
 * #487: the retired JSONL debug journal (`<dataDir>/debug/<day>/<session>.jsonl`, transcripts and full
 * instructions) is unread since `server/host/journal.ts` was deleted, and nothing removed it. One
 * bounded start-up step removes exactly that directory and answers the bytes removed, or null when
 * there is nothing to remove. Only a real directory is touched: a symlink is never followed and never
 * unlinked, and no other entry of the data directory is read or removed. The second start removes
 * nothing, so the receipt is written once.
 */
export function removeRetiredDebugJournal(dataDir: string): number | null {
  const root = join(resolve(dataDir), 'debug');
  const top = lstatSync(root, { throwIfNoEntry: false });
  if (!top?.isDirectory()) return null;
  const bytes = journalBytes(root);
  rmSync(root, { recursive: true, force: true });
  return bytes;
}

function journalBytes(root: string): number {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += journalBytes(path);
    else if (entry.isFile()) total += lstatSync(path, { throwIfNoEntry: false })?.size ?? 0;
  }
  return total;
}

/**
 * The sweep as the start uses it: one receipt on success, one closed receipt on failure, and never a
 * refused start. A read-only or foreign-owned debug directory is the owner's file system, not a
 * reason to keep the app from opening.
 */
function retireDebugJournal(dataDir: string, log: HostLog): void {
  try {
    const bytes = removeRetiredDebugJournal(dataDir);
    if (bytes !== null) log.event({ event: 'debug_journal_removed', bytes });
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? '').toLowerCase();
    log.event({ event: 'debug_journal_removal_failed', code: /^[a-z0-9]{1,16}$/.test(code) ? code : 'failed' });
  }
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
  retireDebugJournal(dataDir, log);
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
    // A calendar connector that recovered reads the digest the start missed. The hook is bound after the
    // composition because the reader it needs is the composition itself.
    let refreshCalendarDigest = (_endpointId: string): void => { /* bound once the composition exists */ };
    // L2: the same for the first connect of a run, whose start read raced the connector.
    let refreshCalendarFirstConnect = (_endpointId: string): void => { /* bound once the composition exists */ };
    const hostStartedAt = (config.now ?? Date.now)();
    const mcp = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir: providerConfigDir, lookupAuthority, deferConnectors: config.deferConnectors === true, log: event => log.event(event), connectorLog: (connector, stage, detail) => log.event({ event: 'connector_failure', connector, stage, ...(detail ?? {}) }), identityLog: (connector, proven, match, endpointId) => log.event({ event: 'connector_identity', connector, proven, match, ...(endpointId === undefined ? {} : { endpointId }) }), lifecycleLog: connectorLifecycleSink({ log: event => log.event(event), onRecovered: endpointId => refreshCalendarDigest(endpointId), onConnected: endpointId => refreshCalendarFirstConnect(endpointId) }) });
    // 1015: the digest's background owner. It reads once at host start and every 15 minutes after, with
    // the connector's own 30 s budget and off every request path, and keeps the fetch time with the text.
    const digestTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const digestNow = config.now ?? Date.now;
    const calendarDigest = new CalendarDigestCache(
      async () => await readCalendarDigest(calendarDigestReader(mcp), { now: digestNow, timeZone: digestTimeZone }),
      { now: digestNow, timeZone: digestTimeZone });
    const digestRefreshLog: CalendarDigestRefreshLog = event => log.event(event);
    refreshCalendarDigest = bindCalendarRecovery({ digest: calendarDigest, endpoints: () => mcp.status().endpoints, grantOf: id => mcp.registry.currentGrant(id), now: digestNow, log: digestRefreshLog });
    refreshCalendarFirstConnect = bindCalendarFirstConnect({ digest: calendarDigest, endpoints: () => mcp.status().endpoints, grantOf: id => mcp.registry.currentGrant(id), startedAt: hostStartedAt, now: digestNow, log: digestRefreshLog });
    // Session memory v1: one async distillation per ended Live session, plus the host-start reconciler.
    // The distiller reuses the text model the provider config already names for chat and tools.
    const providerLoaded = loadProviderConfig({ configDir: providerConfigDir, ownerId: store.assistantId });
    let summaryModel: import('../adapters/model/types.js').ModelPort | null = null;
    let summaryModelId: string | null = null;
    if (providerLoaded.status === 'ready') {
      summaryModelId = providerLoaded.profile.modelId;
      try { summaryModel = boundTextModel(providerConfigDir, providerLoaded, config.modelTesting).model; }
      catch { summaryModel = null; }
    }
    const summarizer = createSummarizer({ store, model: summaryModel, modelId: summaryModelId ?? 'unconfigured',
      modelAllowedClasses: providerLoaded.status === 'ready' ? providerLoaded.route.dataClasses : [],
      assistantName: owner.snapshot.displayName,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: config.now ?? Date.now, log: event => log.event(event) });
    const liveTools: LiveToolsComposition & { onSessionTerminal?: (liveSessionId: string) => void; log?: (event: { event: string } & Record<string, unknown>) => void } = {
      owner: mcp.owner,
      connectionIds: () => mcp.connectionIds(),
      recover: () => mcp.recover(),
      status: () => mcp.status(),
      registerAuthoritySource: source => { authoritySources.push(source); },
      lookupAuthority,
      calendarDigest: { forStart: () => calendarDigest.forStart(), refresh: () => { void calendarDigest.refresh(); } },
      onSessionTerminal: liveSessionId => summarizer.schedule(liveSessionId),
      log: event => log.event(event),
    };
    const { chat, status } = composeChat(store, domain, providerConfigDir, config.modelTesting, config.now, owner.snapshot, liveTools);
    const composeLiveWithTools = composeLive as unknown as (...args: unknown[]) => ReturnType<typeof composeLive>;
    const { service: live } = composeLiveWithTools(store, providerConfigDir, config.liveTesting, config.now, owner.snapshot, liveTools);
    calendarDigest.begin();
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
    // L12d: the same window carries the resource series, one receipt per minute while the call is live.
    const resources = createHostResourceSampler({ log: event => log.event(event), now: config.now ?? Date.now });
    const attach = live.attach.bind(live);
    live.attach = (...args) => {
      const attachment = attach(...args);
      const stopResources = resources.begin();
      void attachment.done.then(snapshot => log.terminal(snapshot.terminal), error => log.error(error))
        .catch(() => console.error('diagnostics_unavailable'))
        .finally(stopResources);
      return attachment;
    };
    startupStage = 'listen';
    const service = await listenService({ store, domain, chat, live, modelStatus: status, ownerProfileStatus: { status: owner.status, displayName: owner.snapshot.displayName }, toolsStatus: () => mcp.status(), mongooseSignIn: createMongooseSignIn({ configDir: effectiveConfigDir, recover: () => mcp.recover() }), webRoot, port, ...(config.now ? { now: config.now } : {}) });
    try {
      const descriptor: RuntimeDescriptor = { schemaVersion: 1, origin: service.origin, authorityEpoch: store.authorityEpoch, assistantId: store.assistantId, pid: process.pid, startedAt: new Date().toISOString() };
      await publish(descriptorPath, descriptor); // Never use a stale descriptor as authority or carry bearer material.
      startupStage = 'ready';
      let closed = false;
      return { store, chat, service, descriptor, descriptorPath, tools: liveTools,
        // 338: the owner's wake instruction, the same one POST api/v1/live/prewarm serves. The live
        // owner writes the one closed `warm_prewarm` line, so either route logs it exactly once.
        prewarm: async (): Promise<WarmPrewarmReceipt> =>
          await live.prewarm(),
        start: () => mcp.start(), async close() {
        if (closed) return; closed = true;
        logExit('ready', 'close');
        removeOwnDescriptor(descriptorPath);
        chat.shutdown();
        calendarDigest.stop();
        try { await service.close(); await live.shutdown(); await mcp.close(); } finally { store.close(); stopDiagnostics(); }
      } };
    } catch (error) { await service.close(); throw error; }
  } catch (error) { log.error(error); stopDiagnostics(); store.close(); throw error; }
}
