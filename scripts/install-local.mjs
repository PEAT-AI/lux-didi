#!/usr/bin/env node
// Explicit local install. Never launches/stops the app or touches durable appdata.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleName, inventory, parseArguments, resourceRoot, run, signBundle, validateArtifact, validateBundle } from './package-local.mjs';

export class InstallRefusal extends Error {
  constructor(kind, reason) { super(`${kind}: ${reason}`); this.name = kind; this.code = kind; }
}
export function refuseLive(bundle) {
  const executable = join(bundle, 'Contents/MacOS/LuxDidi');
  const entry = join(bundle, resourceRoot, 'server/dist/host/index.js');
  const native = run('/bin/ps', ['-axo', 'pid=,comm=']).split('\n');
  const command = run('/bin/ps', ['-axo', 'pid=,command=']).split('\n');
  const found = native.some(line => line.trim().replace(/^\d+\s+/, '') === executable) || command.some(line => line.includes(entry));
  if (found) throw new InstallRefusal('LiveInstance', 'active app/service; explicitly Quit the owned app and retry after clean stop (installer never force-stops)');
}
function pathExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function existingRelease(target) {
  if (!pathExists(target)) return null;
  try {
    const receipt = `${target}.receipt.json`;
    if (lstatSync(target).isSymbolicLink() || lstatSync(receipt).isSymbolicLink()) throw new Error('symlink identity');
    const metadata = JSON.parse(readFileSync(receipt, 'utf8'));
    // Old Node prerequisites can have changed; preserve the legitimate old release without running it.
    return validateBundle(target, metadata, { checkNode: false });
  } catch (error) {
    throw new InstallRefusal('UnrelatedTarget', `existing app identity cannot be verified; preserved unchanged (${error.message})`);
  }
}
export function installArtifact(artifact, destination = join(homedir(), 'Applications', bundleName)) {
  const candidate = validateArtifact(resolve(artifact));
  let target = resolve(destination);
  if (basename(target) !== bundleName) throw new InstallRefusal('InvalidDestination', `destination must end in ${bundleName}`);
  mkdirSync(dirname(target), { recursive: true });
  const parent = realpathSync(dirname(target));
  if (lstatSync(parent).uid !== process.getuid()) throw new InstallRefusal('InvalidDestination', 'destination parent is not owned by current user');
  target = join(parent, basename(target));
  if (target === realpathSync(candidate.bundle)) throw new InstallRefusal('InvalidDestination', 'cannot install an artifact onto itself');
  const lock = join(parent, `.${bundleName}.install-lock`);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new InstallRefusal('InstallBusy', 'sibling installation lock exists; no unknown lock is removed'); }
  const stage = join(lock, 'candidate');
  const stagedBundle = join(stage, bundleName);
  const receipt = `${target}.receipt.json`;
  let previous = null;
  let movedOld = false;
  let movedReceipt = false;
  let activated = false;
  let activatedReceipt = false;
  try {
    const old = existingRelease(target);
    if (!old && pathExists(receipt)) throw new InstallRefusal('UnrelatedTarget', 'orphan destination receipt exists; preserved unchanged');
    refuseLive(target);
    refuseLive(candidate.bundle);
    mkdirSync(stage, { mode: 0o700 });
    cpSync(candidate.bundle, stagedBundle, { recursive: true, dereference: false });
    let metadata = { ...candidate.metadata };
    if (old) {
      const runtime = { ...candidate.runtime, installId: old.runtime.installId };
      writeFileSync(join(stagedBundle, resourceRoot, 'didi-runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
      signBundle(stagedBundle);
      metadata = { ...metadata, installId: old.runtime.installId, inventory: inventory(stagedBundle) };
      previous = join(parent, `.${bundleName}.previous-${randomUUID()}`);
    }
    validateBundle(stagedBundle, metadata);
    metadata = { ...metadata, outcome: 'installed', destination: target, previousRelease: previous ? join(previous, bundleName) : null, installedAt: new Date().toISOString() };
    writeFileSync(join(stage, 'receipt.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // Recheck after staging. No rename/activation occurs before these validations.
    const stillOld = existingRelease(target);
    if (JSON.stringify(stillOld?.metadata ?? null) !== JSON.stringify(old?.metadata ?? null)) throw new InstallRefusal('TargetChanged', 'target changed while staging');
    refuseLive(target);
    if (old) {
      mkdirSync(previous, { mode: 0o700 });
      renameSync(target, join(previous, bundleName)); movedOld = true;
      renameSync(receipt, join(previous, 'receipt.json')); movedReceipt = true;
    }
    renameSync(stagedBundle, target); activated = true;
    renameSync(join(stage, 'receipt.json'), receipt); activatedReceipt = true;
    return metadata;
  } catch (error) {
    // Only paths created/moved by this transaction are reverted; durable data is never involved.
    if (activatedReceipt) rmSync(receipt);
    if (activated) rmSync(target, { recursive: true });
    if (movedOld) renameSync(join(previous, bundleName), target);
    if (movedReceipt) renameSync(join(previous, 'receipt.json'), receipt);
    if (previous && existsSync(previous)) rmSync(previous, { recursive: true });
    throw error;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2), ['--help', '--artifact', '--destination']);
    if (args['--help']) console.log('install-local --artifact /outside/checkout/artifact [--destination /explicit/LuxDidi.app]\nDefault: current user home/Applications/LuxDidi.app. Never launches, stops, reseeds or resets data. Explicit Quit is required before reinstall.');
    else {
      if (!args['--artifact']) throw new Error('--artifact is required');
      const receipt = installArtifact(args['--artifact'], args['--destination']);
      console.log(JSON.stringify({ outcome: receipt.outcome, destination: receipt.destination, releaseCommit: receipt.releaseCommit, installId: receipt.installId, previousRelease: receipt.previousRelease, receipt: `${receipt.destination}.receipt.json` }));
    }
  } catch (error) { console.error(`INSTALL REFUSED: ${error.message}`); process.exitCode = 1; }
}
