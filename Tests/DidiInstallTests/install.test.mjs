import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { inventory, probeNode, validateArtifact, checkPrerequisites, buildArtifact } from '../../scripts/package-local.mjs';
import { installArtifact } from '../../scripts/install-local.mjs';
import { runInstalledReinstallProof } from './installed-proof.mjs';

const root = mkdtempSync(join(tmpdir(), 'didi-install-tests-'));
const node = process.execPath;
const commit = 'a'.repeat(40);
let executable;
// Synthetic R10 producer for parser/process/filesystem mechanics only: no HOST, UI or Keychain proof.
const fixtureProofSource = `
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const resources=dirname(fileURLToPath(import.meta.url)),bundle=resolve(resources,'../..');
const state=process.argv[4],output=process.argv[6];
const runtime=JSON.parse(readFileSync(join(resources,'didi-runtime.json')));
const markerPath=join(state,'didi-installed-proof.json'),reopened=existsSync(markerPath);
const marker=reopened?JSON.parse(readFileSync(markerPath)):{type:'didi-installed-proof-state',schemaVersion:1,installId:runtime.installId,proofId:randomUUID()};
if(!reopened)writeFileSync(markerPath,JSON.stringify(marker),{mode:0o600});
const modePath=join(resources,'fixture-mode.json'),mode=existsSync(modePath)?JSON.parse(readFileSync(modePath)).mode:null;
const storage=join(state,'fixture-records.json'),priorRecords=mode==='forget-prior'?[]:existsSync(storage)?JSON.parse(readFileSync(storage)):[];
const runId=randomUUID(),newRecord={sessionId:randomUUID(),entryId:randomUUID(),text:marker.proofId+' synthetic fixture '+runId,visibleInCanonicalUI:true};
writeFileSync(storage,JSON.stringify([...priorRecords,newRecord]),{mode:0o600});
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const image=join(dirname(output),'fixture-image-'+runId);writeFileSync(image,'fixture bytes, NOT rendered UI',{mode:0o600});
const child=spawnSync(process.execPath,['-e','']);
const report={type:'LuxDidiInstalledProof',schemaVersion:1,phase:mode==='running'?'running':'complete',success:true,runId,installId:runtime.installId,proofId:marker.proofId,reopened,
source:{appIdentifier:'ai.peat.lux-didi',bundlePath:bundle,releaseCommit:runtime.releaseCommit,nativeExecutableSHA256:digest(join(bundle,'Contents/MacOS/LuxDidi')),manifestSHA256:digest(join(resources,'didi-runtime.json')),serverEntrySHA256:digest(join(resources,runtime.serverEntry)),nodePath:runtime.nodePath,serverEntry:runtime.serverEntry,webRoot:runtime.webRoot},
native:{pid:mode==='stale'?process.pid-1:process.pid,cleanQuitRequested:true,exitEvidence:'external-driver-required'},service:{pid:child.pid,nonce:'abcdefghijklmnop',origin:'http://127.0.0.1:43210',authorityEpoch:randomUUID(),assistantId:randomUUID(),readyVerified:true},priorRecords,newRecord,
observations:{credentialImported:true,bootstrap:true,canonicalUIReady:true,priorRecallComplete:true,newSaved:true},
visual:{windowId:null,screenCapturePermission:false,pageSnapshot:{method:'actual-WKWebView.takeSnapshot',path:image,width:1,height:1,sha256:digest(image)},nativeChrome:null,nativeChromeLimitation:'native chrome not visually verified: fixture has no permission/UI',accessibility:['Start recording','Stop recording','Send text'].map(name=>({name,enabled:false,visible:true})),rootVisualReviewRequired:true},
serviceStop:{requested:true,observedExited:true,pid:child.pid,exitStatus:child.status,terminationReason:'exit',procedure:'private-stdin-close-and-bounded-owned-escalation'},credentialCleanup:{scope:'synthetic-proof-only',attempted:true,cleaned:true,errorCode:null},error:null};
writeFileSync(output,JSON.stringify(report),{mode:0o600});
if(mode==='exit7')process.exitCode=7;
`;
before(() => {
  // Signed C launcher execs an explicit test-only Node fixture, preserving observed PID.
  writeFileSync(join(root, 'fixture.c'), `#include <unistd.h>\n#include <stdio.h>\n#include <string.h>\nint main(int argc,char **argv){if(argc==6 && strcmp(argv[1],"--installed-proof")==0 && strcmp(argv[2],"--proof-state")==0 && strcmp(argv[4],"--proof-report")==0){char path[4096];snprintf(path,sizeof(path),"%s",argv[0]);char *last=strrchr(path,'/');if(!last)return 2;*last=0;strcat(path,"/../Resources/fixture-proof.mjs");char *args[]={${JSON.stringify(process.execPath)},path,argv[1],argv[2],argv[3],argv[4],argv[5],NULL};execv(args[0],args);return 2;}sleep(20);return 0;}\n`);
  executable = join(root, 'fixture');
  execFileSync('/usr/bin/xcrun', ['clang', join(root, 'fixture.c'), '-o', executable]);
});
after(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const dir = mkdtempSync(join(root, 'artifact-'));
  const bundle = join(dir, 'LuxDidi.app');
  const resources = join(bundle, 'Contents/Resources');
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(resources, 'server/dist/host'), { recursive: true });
  mkdirSync(join(resources, 'web/dist'), { recursive: true });
  copyFileSync(executable, join(bundle, 'Contents/MacOS/LuxDidi'));
  copyFileSync(resolve('Resources/Info.plist'), join(bundle, 'Contents/Info.plist'));
  copyFileSync(resolve('Resources/LuxDidi.entitlements'), join(resources, 'LuxDidi.entitlements'));
  writeFileSync(join(resources, 'server/dist/host/index.js'), '// Test-only asset: never claims accepted HOST integration.\n');
  writeFileSync(join(resources, 'fixture-proof.mjs'), fixtureProofSource);
  writeFileSync(join(resources, 'web/dist/index.html'), '<p>test-only</p>');
  const runtime = { schemaVersion: 1, installId: randomUUID(), releaseCommit: commit, nodePath: node, nodeMajor: 26, serverEntry: 'server/dist/host/index.js', webRoot: 'web/dist' };
  writeFileSync(join(resources, 'didi-runtime.json'), JSON.stringify(runtime));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', join(resources, 'LuxDidi.entitlements'), bundle], { stdio: 'pipe' });
  const metadata = { schemaVersion: 1, artifactType: 'lux-didi-local-development', releaseCommit: commit, installId: runtime.installId, node: probeNode(node), signingIdentity: 'ad-hoc', inventory: inventory(bundle) };
  writeFileSync(join(dir, 'artifact.json'), JSON.stringify(metadata));
  return { dir, bundle, resources, runtime, metadata };
}
function destination() { return join(mkdtempSync(join(root, 'destination-')), 'LuxDidi.app'); }
function rendererFixture() {
  const slot = join(root, 'fixture-slot');
  if (!existsSync(slot)) {
    writeFileSync(join(root, 'slot.c'), '#include <unistd.h>\nint main(int argc,char **argv){if(argc<6)return 2;execv(argv[5],&argv[5]);return 3;}\n');
    execFileSync('/usr/bin/xcrun', ['clang', join(root, 'slot.c'), '-o', slot]);
  }
  return slot;
}
function resign(f) {
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', join(f.resources, 'LuxDidi.entitlements'), f.bundle], { stdio: 'pipe' });
  f.metadata.inventory = inventory(f.bundle);
  writeFileSync(join(f.dir, 'artifact.json'), JSON.stringify(f.metadata));
}

test('explicit Node is realpath-resolved, executable, exactly 26 with real SQLite and dylib process probe', () => {
  const result = probeNode(node);
  assert.equal(result.major, 26);
  assert.match(result.version, /^v26\./);
  assert.equal(result.path, node);
  assert.equal(result.sqlite, true);
  assert.ok(result.sha256);
  assert.ok(result.linkage.length);
  const oldOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require=/nonexistent/didi-scrubbed-env-sentinel';
  try { assert.equal(probeNode(node).major, 26); }
  finally { if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions; }
  assert.throws(() => probeNode(join(root, 'missing-node')), /Node/i);
  assert.throws(() => probeNode('/usr/bin/false'), /Node/i);
  const fake = join(root, 'wrong-node');
  writeFileSync(fake, '#!/bin/sh\nprintf \'{"version":"v25.0.0","major":25,"sqlite":true}\\n\'\n');
  chmodSync(fake, 0o700);
  assert.throws(() => probeNode(fake), /Node 26/);
});

test('dirty or mismatched clean source identity refuses before compilation', () => {
  const source = mkdtempSync(join(root, 'source-'));
  execFileSync('/usr/bin/git', ['init', '-q', source]);
  writeFileSync(join(source, 'tracked'), 'source');
  execFileSync('/usr/bin/git', ['-C', source, 'add', 'tracked']);
  execFileSync('/usr/bin/git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const head = execFileSync('/usr/bin/git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const options = { source, output: join(root, 'unused-output'), nodePath: node };
  assert.throws(() => buildArtifact({ ...options, sourceCommit: commit }), /source HEAD/i);
  writeFileSync(join(source, 'tracked'), 'dirty');
  assert.throws(() => buildArtifact({ ...options, sourceCommit: head }), /clean/i);
  assert.equal(existsSync(options.output), false);
});

test('accepted source capability gate refuses absent HOST or COMPANION rather than fake packaging', () => {
  const source = mkdtempSync(join(root, 'no-runtime-'));
  assert.throws(() => checkPrerequisites(source), /HOST/);
  mkdirSync(join(source, 'server/host'), { recursive: true });
  writeFileSync(join(source, 'server/host/index.ts'), '');
  assert.throws(() => checkPrerequisites(source), /COMPANION/);
});

test('signed inventory rejects stale artifacts, source mismatch, missing assets and Node substitution', () => {
  const f = fixture();
  assert.equal(validateArtifact(f.dir).runtime.installId, f.runtime.installId);
  assert.throws(() => validateArtifact(f.dir, { sourceCommit: 'b'.repeat(40) }), /source/i);
  writeFileSync(join(f.resources, 'web/dist/index.html'), 'tampered');
  assert.throws(() => validateArtifact(f.dir), /inventory|signature/i);
  const missing = fixture();
  rmSync(join(missing.resources, 'server/dist/host/index.js'));
  resign(missing);
  assert.throws(() => validateArtifact(missing.dir), /host|serverEntry/i);
  const badNode = fixture();
  badNode.metadata.node.sha256 = '0'.repeat(64);
  writeFileSync(join(badNode.dir, 'artifact.json'), JSON.stringify(badNode.metadata));
  assert.throws(() => validateArtifact(badNode.dir), /Node.*identity/i);
});

test('inventory forbids dotenv/private state and symlinks even inside signed bundle', () => {
  for (const name of ['.env', 'private-state/admin-credential', 'web/dist/.env.local']) {
    const f = fixture();
    const path = join(f.resources, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, 'arbitrary sentinel, not a real secret');
    assert.throws(() => inventory(f.bundle), /forbidden/i);
  }
  const f = fixture();
  symlinkSync('/etc', join(f.resources, 'escape'));
  assert.throws(() => inventory(f.bundle), /symlink/i);
});

test('dangling unrelated target symlink is preserved, not silently replaced', () => {
  const f = fixture();
  const target = destination();
  symlinkSync(join(root, 'nonexistent-unrelated'), target);
  assert.throws(() => installArtifact(f.dir, target), /UnrelatedTarget/);
  assert.equal(execFileSync('/usr/bin/readlink', [target], { encoding: 'utf8' }).trim(), join(root, 'nonexistent-unrelated'));
});

test('unrelated target refuses without modifying it', () => {
  const f = fixture();
  const target = destination();
  mkdirSync(target);
  writeFileSync(join(target, 'unrelated'), 'preserve');
  assert.throws(() => installArtifact(f.dir, target), /UnrelatedTarget/);
  assert.equal(readFileSync(join(target, 'unrelated'), 'utf8'), 'preserve');
});

test('reinstall preserves unrelated neighbor sentinel and install identity; previous release kept for rollback', () => {
  const first = fixture();
  const target = destination();
  // A useful neighboring-directory control, NOT proof of real Didi appdata preservation.
  const neighbor = join(root, 'unrelated-neighbor');
  mkdirSync(neighbor);
  writeFileSync(join(neighbor, 'sentinel'), 'unrelated directory must survive');
  const initial = installArtifact(first.dir, target);
  const second = fixture();
  const updated = installArtifact(second.dir, target);
  assert.equal(updated.installId, initial.installId);
  assert.notEqual(updated.installId, second.runtime.installId);
  assert.equal(readFileSync(join(neighbor, 'sentinel'), 'utf8'), 'unrelated directory must survive');
  assert.ok(existsSync(updated.previousRelease));
  assert.equal(JSON.parse(readFileSync(join(target, 'Contents/Resources/didi-runtime.json'))).installId, initial.installId);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', target]);
});

test('R10 wiring compares same-state fixture records across real reinstall/relocation; actual accepted app remains unproven', () => {
  const first = fixture();
  const second = fixture();
  const proofRoot = mkdtempSync(join(root, 'proof-sequence-'));
  chmodSync(proofRoot, 0o700);
  const slot = rendererFixture();
  const result = runInstalledReinstallProof({ firstArtifact: first.dir, reinstallArtifact: second.dir, proofRoot, browserSlot: slot, sourceCommit: commit });
  assert.equal(result.firstReport.reopened, false);
  assert.equal(result.secondReport.reopened, true);
  assert.deepEqual(result.secondReport.priorRecords, [result.firstReport.newRecord]);
  assert.notEqual(result.firstReport.runId, result.secondReport.runId);
  assert.equal(JSON.parse(readFileSync(join(result.proofState, 'fixture-records.json'))).length, 2);
  assert.ok(result.nativeExits.every(exit => exit.exitCode === 0 && exit.signal === null));
  assert.equal(result.firstInstallId, result.reinstallId);
  assert.notEqual(result.reinstallId, second.runtime.installId);
  assert.equal(existsSync(result.originalBundle), false);
  assert.ok(existsSync(join(result.relocatedBundle, 'Contents/Resources/server/dist/host/index.js')));
  assert.equal(result.functionalComparisonsPassed, true);
  assert.equal(result.rootVisualReviewRequired, true);
  assert.match(result.secondReport.visual.nativeChromeLimitation, /not visually verified/);
});

for (const mode of ['exit7', 'running', 'stale', 'forget-prior']) {
  test(`real external driver rejects fixture ${mode} despite renderer wrapper exit0`, () => {
    const first = fixture(), second = fixture();
    const changed = mode === 'forget-prior' ? second : first;
    writeFileSync(join(changed.resources, 'fixture-mode.json'), JSON.stringify({ mode }));
    resign(changed);
    const proofRoot = mkdtempSync(join(root, 'negative-proof-'));
    chmodSync(proofRoot, 0o700);
    assert.throws(() => runInstalledReinstallProof({ firstArtifact: first.dir, reinstallArtifact: second.dir, proofRoot, browserSlot: rendererFixture(), sourceCommit: commit }), /Installed proof/);
  });
}

test('live actual owned native subprocess produces typed refusal; no force stop', async () => {
  const f = fixture();
  const target = destination();
  installArtifact(f.dir, target);
  const child = spawn(join(target, 'Contents/MacOS/LuxDidi'), [], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    assert.throws(() => installArtifact(f.dir, target), /LiveInstance/);
    assert.equal(child.exitCode, null);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
});

test('live actual Node service subprocess produces typed refusal', async () => {
  const f = fixture();
  const target = destination();
  writeFileSync(join(f.resources, 'server/dist/host/index.js'), 'setInterval(() => {}, 1000);');
  resign(f);
  installArtifact(f.dir, target);
  const child = spawn(node, [join(target, 'Contents/Resources/server/dist/host/index.js')], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try { assert.throws(() => installArtifact(f.dir, target), /LiveInstance/); }
  finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
});

test('real staged validation failure leaves prior target and receipt untouched', () => {
  const f = fixture();
  const target = destination();
  installArtifact(f.dir, target);
  const priorReceipt = readFileSync(`${target}.receipt.json`, 'utf8');
  const priorRuntime = readFileSync(join(target, 'Contents/Resources/didi-runtime.json'), 'utf8');
  const second = fixture();
  // Signed candidate is valid, but its unsuitable entitlements make reinstall resign fail.
  writeFileSync(join(second.resources, 'LuxDidi.entitlements'), 'not a plist');
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', second.bundle], { stdio: 'pipe' });
  second.metadata.inventory = inventory(second.bundle);
  writeFileSync(join(second.dir, 'artifact.json'), JSON.stringify(second.metadata));
  assert.throws(() => installArtifact(second.dir, target), /sign|entitlements/i);
  assert.equal(readFileSync(`${target}.receipt.json`, 'utf8'), priorReceipt);
  assert.equal(readFileSync(join(target, 'Contents/Resources/didi-runtime.json'), 'utf8'), priorRuntime);
});
