// R10 consumer and external process observer. Native owns data/bootstrap/capture.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact, bundleName, run, scrubbedEnvironment, validateArtifact, validateBundle } from '../../scripts/package-local.mjs';
import { installArtifact, refuseLive } from '../../scripts/install-local.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function requireProof(condition, field) { if (!condition) throw new Error(`Installed proof invalid: ${field}`); }
function object(value, fields, label) {
  requireProof(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === fields.split(' ').sort().join(), label);
}
function record(value, proofId) {
  object(value, 'sessionId entryId text visibleInCanonicalUI', 'record schema');
  requireProof(uuid.test(value.sessionId) && uuid.test(value.entryId) && typeof value.text === 'string' && value.text.includes(proofId) && value.visibleInCanonicalUI === true, 'record identity/full text/canonical UI');
}
function image(value, method) {
  object(value, 'method path width height sha256', 'visual image schema');
  requireProof(value.method === method && isAbsolute(value.path) && positive(value.width) && positive(value.height) && hex64.test(value.sha256), 'visual image identity');
  const info = lstatSync(value.path);
  requireProof(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && hash(readFileSync(value.path)) === value.sha256, 'visual image bytes');
}
function ownedJson(path, maxBytes = 65536) {
  const info = lstatSync(path);
  requireProof(!info.isSymbolicLink() && info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.size <= maxBytes, 'owned 0600 bounded JSON file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function validateInstalledReport(report, context) {
  object(report, 'type schemaVersion phase success runId installId proofId reopened source native service priorRecords newRecord observations visual serviceStop credentialCleanup error', 'report schema');
  requireProof(report.type === 'LuxDidiInstalledProof' && report.schemaVersion === 1 && report.phase === 'complete' && report.success === true && report.error === null, 'type/version/complete/success');
  requireProof(uuid.test(report.runId) && uuid.test(report.installId) && uuid.test(report.proofId) && report.installId === context.installId && report.proofId === context.proofId && typeof report.reopened === 'boolean' && report.reopened === context.reopened, 'identity/reopen');
  object(report.source, 'appIdentifier bundlePath releaseCommit nativeExecutableSHA256 manifestSHA256 serverEntrySHA256 nodePath serverEntry webRoot', 'source schema');
  requireProof(hex40.test(report.source.releaseCommit) && ['nativeExecutableSHA256', 'manifestSHA256', 'serverEntrySHA256'].every(key => hex64.test(report.source[key])) && Object.keys(report.source).every(key => report.source[key] === context.source[key]), 'source/actual component hashes');
  object(report.native, 'pid cleanQuitRequested exitEvidence', 'native schema (no self-exit claim)');
  const exit = context.nativeExit;
  requireProof(exit && positive(exit.pid) && exit.exitCode === 0 && exit.signal === null && report.native.pid === exit.pid, 'external native exit/PID');
  requireProof(report.native.cleanQuitRequested === true && report.native.exitEvidence === 'external-driver-required', 'native clean Quit');
  object(report.service, 'pid nonce origin authorityEpoch assistantId readyVerified', 'service schema');
  const port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(report.service.origin);
  requireProof(positive(report.service.pid) && report.service.pid !== exit.pid && /^[A-Za-z0-9_-]{16,128}$/.test(report.service.nonce) && port && Number(port[1]) <= 65535 && uuid.test(report.service.authorityEpoch) && uuid.test(report.service.assistantId) && report.service.readyVerified === true, 'service ready identity');
  object(report.serviceStop, 'requested observedExited pid exitStatus terminationReason procedure', 'serviceStop schema');
  requireProof(report.serviceStop.requested === true && report.serviceStop.observedExited === true && report.serviceStop.pid === report.service.pid && Number.isSafeInteger(report.serviceStop.exitStatus) && ['exit', 'uncaughtSignal'].includes(report.serviceStop.terminationReason) && report.serviceStop.procedure === 'private-stdin-close-and-bounded-owned-escalation', 'serviceStop actual exit');
  object(report.observations, 'credentialImported bootstrap canonicalUIReady priorRecallComplete newSaved', 'observations schema');
  requireProof(Object.values(report.observations).every(value => value === true), 'functional observations');
  object(report.credentialCleanup, 'scope attempted cleaned errorCode', 'credentialCleanup schema');
  requireProof(report.credentialCleanup.scope === 'synthetic-proof-only' && report.credentialCleanup.attempted === true && report.credentialCleanup.cleaned === true && report.credentialCleanup.errorCode === null, 'synthetic credential cleanup');
  requireProof(Array.isArray(report.priorRecords), 'priorRecords array');
  for (const prior of report.priorRecords) record(prior, report.proofId);
  record(report.newRecord, report.proofId);
  requireProof(report.newRecord.text.includes(report.runId) && new Set([...report.priorRecords, report.newRecord].map(value => value.entryId)).size === report.priorRecords.length + 1, 'unique new record/run text');
  object(report.visual, 'windowId screenCapturePermission pageSnapshot nativeChrome nativeChromeLimitation accessibility rootVisualReviewRequired', 'visual schema');
  const visual = report.visual;
  requireProof((visual.windowId === null || positive(visual.windowId)) && typeof visual.screenCapturePermission === 'boolean' && visual.rootVisualReviewRequired === true && (visual.nativeChromeLimitation === null || (typeof visual.nativeChromeLimitation === 'string' && visual.nativeChromeLimitation.length > 0)), 'separate root visual review');
  image(visual.pageSnapshot, 'actual-WKWebView.takeSnapshot');
  if (visual.nativeChrome !== null) {
    requireProof(visual.screenCapturePermission === true, 'native chrome permission');
    image(visual.nativeChrome, 'ScreenCaptureKit.currentProcess');
  } else requireProof(typeof visual.nativeChromeLimitation === 'string' && visual.nativeChromeLimitation.length > 0, 'native chrome limitation');
  requireProof(Array.isArray(visual.accessibility), 'accessibility array');
  for (const control of visual.accessibility) {
    object(control, 'name enabled visible', 'accessibility control');
    requireProof(typeof control.name === 'string' && typeof control.enabled === 'boolean' && typeof control.visible === 'boolean', 'accessibility states');
  }
  for (const name of ['Start recording', 'Stop recording', 'Send text']) requireProof(visual.accessibility.filter(control => control.name === name).length === 1, 'required native accessibility controls');
  return report;
}
export function compareInstalledReports(first, second) {
  requireProof(first.runId !== second.runId && first.installId === second.installId && first.proofId === second.proofId && first.reopened === false && first.priorRecords.length === 0 && second.reopened === true, 'unique invocation/stable identity/reopen');
  for (const key of ['appIdentifier', 'releaseCommit', 'serverEntrySHA256', 'nodePath', 'serverEntry', 'webRoot']) requireProof(first.source[key] === second.source[key], 'source across reinstall');
  const expected = [...first.priorRecords, first.newRecord];
  requireProof(second.priorRecords.length === expected.length && expected.every(prior => second.priorRecords.some(value => ['sessionId', 'entryId', 'text', 'visibleInCanonicalUI'].every(key => value[key] === prior[key]))) && new Set(second.priorRecords.map(value => value.entryId)).size === expected.length && !expected.some(prior => prior.entryId === second.newRecord.entryId), 'exact prior/new records after reinstall/move');
  return true;
}
function sourceAt(bundle, metadata, runtime, sourceCommit) {
  requireProof(runtime.releaseCommit === sourceCommit && metadata.releaseCommit === sourceCommit, 'accepted source pin');
  const component = path => {
    const entry = metadata.inventory.find(item => item.path === path && item.type === 'file');
    requireProof(entry && hex64.test(entry.sha256), 'component inventory');
    return entry.sha256;
  };
  return { appIdentifier: 'ai.peat.lux-didi', bundlePath: realpathSync(bundle), releaseCommit: sourceCommit, nativeExecutableSHA256: component('Contents/MacOS/LuxDidi'), manifestSHA256: component('Contents/Resources/didi-runtime.json'), serverEntrySHA256: component(`Contents/Resources/${runtime.serverEntry}`), nodePath: runtime.nodePath, serverEntry: runtime.serverEntry, webRoot: runtime.webRoot };
}
export function runInstalledReinstallProof({ firstArtifact, reinstallArtifact, proofRoot, browserSlot, sourceCommit }) {
  requireProof(hex40.test(sourceCommit), 'explicit accepted source pin');
  if (!isAbsolute(proofRoot ?? '') || !isAbsolute(browserSlot ?? '')) throw new Error('Explicit absolute owned proof root and installed renderer-slot executable required');
  const info = lstatSync(proofRoot);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || readdirSync(proofRoot).length) throw new Error('Proof root must be empty, owner-only0700 and not a symlink');
  proofRoot = realpathSync(proofRoot); browserSlot = realpathSync(browserSlot); accessSync(browserSlot, constants.X_OK);
  const first = validateArtifact(firstArtifact, { sourceCommit });
  const second = validateArtifact(reinstallArtifact, { sourceCommit });
  if (first.runtime.installId === second.runtime.installId) throw new Error('Reinstall proof requires independently built artifacts with distinct generated identities');
  const proofState = join(proofRoot, 'state');
  const reports = join(proofRoot, 'reports');
  mkdirSync(proofState, { mode: 0o700 }); mkdirSync(reports, { mode: 0o700 });
  const originalBundle = join(proofRoot, 'installed', bundleName);
  const initial = installArtifact(firstArtifact, originalBundle);
  const invoke = (bundle, metadata, reportPath, reopened) => {
    requireProof(!existsSync(reportPath), 'fresh report path');
    const selected = validateBundle(bundle, metadata);
    const source = sourceAt(bundle, metadata, selected.runtime, sourceCommit);
    // The observer directly spawns/awaits native; slot exit/report self-claims are not native-exit evidence.
    const observed = JSON.parse(run(browserSlot, ['run', '--wait', '120', '--', process.execPath, fileURLToPath(import.meta.url), '--observe-native', join(bundle, 'Contents/MacOS/LuxDidi'), '--installed-proof', '--proof-state', proofState, '--proof-report', reportPath], { env: scrubbedEnvironment(homedir()), stdio: ['ignore', 'pipe', 'pipe'] }));
    requireProof(observed && observed.exitCode === 0 && observed.signal === null && positive(observed.pid), 'external native exit');
    refuseLive(bundle);
    validateBundle(bundle, metadata); // Native must not mutate signed runtime resources.
    const marker = ownedJson(join(proofState, 'didi-installed-proof.json'));
    object(marker, 'type schemaVersion installId proofId', 'lifecycle marker');
    requireProof(marker.type === 'didi-installed-proof-state' && marker.schemaVersion === 1 && marker.installId === initial.installId && uuid.test(marker.proofId), 'lifecycle marker identity');
    return { report: validateInstalledReport(ownedJson(reportPath), { source, installId: initial.installId, proofId: marker.proofId, reopened, nativeExit: observed }), nativeExit: observed };
  };
  const firstRun = invoke(originalBundle, initial, join(reports, 'first.json'), false);
  // Native alone owns retained state. No clearing/reseeding/record cache or direct SQL.
  const reinstall = installArtifact(reinstallArtifact, originalBundle);
  if (reinstall.installId !== initial.installId) throw new Error('Real reinstall changed install identity');
  const relocatedBundle = join(proofRoot, 'relocated', bundleName);
  mkdirSync(join(proofRoot, 'relocated'), { mode: 0o700 });
  renameSync(originalBundle, relocatedBundle); renameSync(`${originalBundle}.receipt.json`, `${relocatedBundle}.receipt.json`);
  requireProof(!existsSync(originalBundle), 'original bundle removed by relocation');
  const secondRun = invoke(relocatedBundle, reinstall, join(reports, 'second.json'), true);
  compareInstalledReports(firstRun.report, secondRun.report);
  return { functionalComparisonsPassed: true, rootVisualReviewRequired: true, proofState, originalBundle, relocatedBundle, firstInstallId: initial.installId, reinstallId: reinstall.installId, firstReport: firstRun.report, secondReport: secondRun.report, nativeExits: [firstRun.nativeExit, secondRun.nativeExit] };
}
export function runBuiltInstalledReinstallProof({ build, workRoot, browserSlot }) {
  const info = lstatSync(workRoot);
  if (!isAbsolute(workRoot) || info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || readdirSync(workRoot).length) throw new Error('Build/proof work root must be an empty owned0700 directory');
  workRoot = realpathSync(workRoot);
  const firstArtifact = join(workRoot, 'first-artifact'); const reinstallArtifact = join(workRoot, 'reinstall-artifact');
  buildArtifact({ ...build, output: firstArtifact }); buildArtifact({ ...build, output: reinstallArtifact });
  const proofRoot = join(workRoot, 'proof'); mkdirSync(proofRoot, { mode: 0o700 });
  return runInstalledReinstallProof({ firstArtifact, reinstallArtifact, proofRoot, browserSlot, sourceCommit: build.sourceCommit });
}
// Private test-harness observer, NOT another native report schema or installed resource.
// Only observed child exit is emitted. Native cannot certify its own exit.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--observe-native') {
  const executable = process.argv[3];
  requireProof(isAbsolute(executable ?? ''), 'absolute native executable');
  const argv = process.argv.slice(4);
  requireProof(argv.length === 5 && argv[0] === '--installed-proof' && argv[1] === '--proof-state' && isAbsolute(argv[2]) && argv[3] === '--proof-report' && isAbsolute(argv[4]), 'exact installed-only native argv');
  const child = spawn(executable, argv, { env: scrubbedEnvironment(homedir()), stdio: 'ignore' });
  let escalation;
  const stop = () => { child.kill('SIGTERM'); escalation ??= setTimeout(() => child.kill('SIGKILL'), 10000); };
  const deadline = setTimeout(stop, 170000);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  child.once('error', () => { clearTimeout(deadline); clearTimeout(escalation); process.exitCode = 1; });
  child.once('exit', (exitCode, signal) => { clearTimeout(deadline); clearTimeout(escalation); console.log(JSON.stringify({ pid: child.pid, exitCode, signal })); });
}
// Caller owns disposable roots/cleanup; failure never authorizes erasing durable state or unknown PID termination.
