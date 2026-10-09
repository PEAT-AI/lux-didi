import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInstalledReport, compareInstalledReports } from './installed-proof.mjs';

// Contract fixtures, NOT accepted native/UI reports or visual evidence.
const root = mkdtempSync(join(tmpdir(), 'didi-report-tests-'));
after(() => rmSync(root, { recursive: true, force: true }));
const imagePath = join(root, 'image-fixture');
const bytes = Buffer.from('test-only image identity bytes, not a rendered UI');
writeFileSync(imagePath, bytes, { mode: 0o600 });
const image = { method: 'actual-WKWebView.takeSnapshot', path: imagePath, width: 1, height: 1, sha256: createHash('sha256').update(bytes).digest('hex') };
const installId = randomUUID();
const proofId = randomUUID();
const source = { appIdentifier: 'ai.peat.lux-didi', bundlePath: join(root, 'LuxDidi.app'), releaseCommit: 'a'.repeat(40), nativeExecutableSHA256: 'b'.repeat(64), manifestSHA256: 'c'.repeat(64), serverEntrySHA256: 'd'.repeat(64), nodePath: process.execPath, serverEntry: 'server/dist/host/index.js', webRoot: 'web/dist' };
function sample({ pid = 12345, reopened = false, priorRecords = [] } = {}) {
  const runId = randomUUID();
  return {
    type: 'LuxDidiInstalledProof', schemaVersion: 1, phase: 'complete', success: true, runId, installId, proofId, reopened, source: { ...source },
    native: { pid, cleanQuitRequested: true, exitEvidence: 'external-driver-required' },
    service: { pid: pid + 1, nonce: 'abcdefghijklmnop', origin: 'http://127.0.0.1:43210', authorityEpoch: randomUUID(), assistantId: randomUUID(), readyVerified: true },
    priorRecords, newRecord: { sessionId: randomUUID(), entryId: randomUUID(), text: `${proofId} synthetic ${runId}`, visibleInCanonicalUI: true },
    observations: { credentialImported: true, bootstrap: true, canonicalUIReady: true, priorRecallComplete: true, newSaved: true },
    visual: { windowId: null, screenCapturePermission: false, pageSnapshot: { ...image }, nativeChrome: null, nativeChromeLimitation: 'native chrome not visually verified: permission unavailable', accessibility: ['Start recording', 'Stop recording', 'Send text'].map(name => ({ name, enabled: false, visible: true })), rootVisualReviewRequired: true },
    serviceStop: { requested: true, observedExited: true, pid: pid + 1, exitStatus: 0, terminationReason: 'exit', procedure: 'private-stdin-close-and-bounded-owned-escalation' },
    credentialCleanup: { scope: 'synthetic-proof-only', attempted: true, cleaned: true, errorCode: null }, error: null,
  };
}
function context(report) {
  return { source, installId, proofId, reopened: report.reopened, nativeExit: { pid: report.native.pid, exitCode: 0, signal: null } };
}
function validate(report, overrides = {}) { return validateInstalledReport(report, { ...context(report), ...overrides }); }

test('exact complete v1 report validates, retaining root visual review and permission limitation', () => {
  const report = sample();
  assert.equal(validate(report), report);
  assert.equal(report.visual.rootVisualReviewRequired, true);
  assert.match(report.visual.nativeChromeLimitation, /not visually verified/);
});

test('strict schema refuses missing/extra/versioned/running/failed reports and self-certified native exit', () => {
  for (const change of [r => delete r.error, r => r.schemaVersion = 2, r => r.type = 'other', r => r.phase = 'running', r => r.phase = 'failed', r => r.success = false, r => r.extra = true, r => r.native.exitCode = 0, r => r.runId = 'invalid', r => r.service = null, r => r.newRecord = null]) {
    const report = sample(); change(report);
    assert.throws(() => validate(report), /Installed proof/);
  }
});

test('actual external native exit and PID are mandatory, never inferred from report success', () => {
  const report = sample();
  for (const nativeExit of [null, { pid: report.native.pid, exitCode: 1, signal: null }, { pid: report.native.pid, exitCode: null, signal: 'SIGTERM' }, { pid: report.native.pid + 2, exitCode: 0, signal: null }]) assert.throws(() => validate(report, { nativeExit }), /native exit/);
});

test('source/install/proof and actual component hashes are pinned to external artifact context', () => {
  for (const key of Object.keys(source)) {
    const report = sample(); report.source[key] = key.endsWith('SHA256') ? '0'.repeat(64) : 'mismatch';
    assert.throws(() => validate(report), /source/);
  }
  for (const key of ['installId', 'proofId']) {
    const report = sample(); report[key] = randomUUID();
    assert.throws(() => validate(report), /identity/);
  }
});

test('success requires verified service stop, clean Quit, observations and synthetic credential cleanup', () => {
  for (const change of [r => r.serviceStop.observedExited = false, r => r.serviceStop.pid++, r => r.serviceStop.exitStatus = null, r => r.native.cleanQuitRequested = false, r => r.observations.priorRecallComplete = false, r => r.service.readyVerified = false, r => r.service.origin = 'http://localhost:43210', r => r.credentialCleanup.cleaned = false, r => r.error = { code: 'failed' }]) {
    const report = sample(); change(report);
    assert.throws(() => validate(report), /Installed proof/);
  }
});

test('reinstall comparison requires unique run, stable identity, exact retrieved prior IDs/full text/UI visibility', () => {
  const first = sample();
  const second = sample({ pid: 22345, reopened: true, priorRecords: [{ ...first.newRecord }] });
  validate(first); validate(second);
  assert.equal(compareInstalledReports(first, second), true);
  for (const change of [r => r.runId = first.runId, r => r.installId = randomUUID(), r => r.proofId = randomUUID(), r => r.reopened = false, r => r.source.releaseCommit = 'e'.repeat(40), r => r.priorRecords = [], r => r.priorRecords[0].sessionId = randomUUID(), r => r.priorRecords[0].entryId = randomUUID(), r => r.priorRecords[0].text += 'truncated/changed', r => r.priorRecords[0].visibleInCanonicalUI = false, r => r.priorRecords.push({ ...first.newRecord }), r => r.newRecord.entryId = first.newRecord.entryId]) {
    const changed = structuredClone(second); change(changed);
    assert.throws(() => compareInstalledReports(first, changed), /Installed proof/);
  }
});

test('visual permission absence never becomes chrome approval; image bytes/method and required controls verified', () => {
  for (const change of [r => r.visual.nativeChromeLimitation = null, r => r.visual.rootVisualReviewRequired = false, r => r.visual.pageSnapshot.sha256 = '0'.repeat(64), r => r.visual.pageSnapshot.method = 'cached-white-button', r => r.visual.accessibility.pop()]) {
    const report = sample(); change(report);
    assert.throws(() => validate(report), /Installed proof/);
  }
});
