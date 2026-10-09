// Acceptance wiring only; native owns data, bootstrap, synthetic capture and cleanup.
// Report interpretation awaits the owning durable-record contract; never infer it.
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { buildArtifact, bundleName, run, scrubbedEnvironment, validateArtifact, validateBundle } from '../../scripts/package-local.mjs';
import { installArtifact, refuseLive } from '../../scripts/install-local.mjs';

function reportAt(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid() || info.size > 65536) throw new Error('Installed proof report must be a bounded owned regular file');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (!report || Array.isArray(report) || typeof report !== 'object' || !Object.keys(report).length) throw new Error('Installed proof report must be a nonempty JSON object');
  return report;
}
export function runInstalledReinstallProof({ firstArtifact, reinstallArtifact, proofRoot, browserSlot }) {
  if (!isAbsolute(proofRoot ?? '') || !isAbsolute(browserSlot ?? '')) throw new Error('Explicit absolute owned proof root and installed renderer-slot executable required');
  const info = lstatSync(proofRoot);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || readdirSync(proofRoot).length) throw new Error('Proof root must be empty, owner-only 0700 and not a symlink');
  proofRoot = realpathSync(proofRoot);
  browserSlot = realpathSync(browserSlot);
  accessSync(browserSlot, constants.X_OK);
  const first = validateArtifact(firstArtifact);
  const second = validateArtifact(reinstallArtifact);
  if (first.metadata.releaseCommit !== second.metadata.releaseCommit) throw new Error('Both real build artifacts must have the same accepted source identity');
  if (first.runtime.installId === second.runtime.installId) throw new Error('Reinstall proof requires two independently built artifacts with distinct generated identities');
  const proofState = join(proofRoot, 'state');
  const reports = join(proofRoot, 'reports');
  mkdirSync(proofState, { mode: 0o700 });
  mkdirSync(reports, { mode: 0o700 });
  const originalBundle = join(proofRoot, 'installed', bundleName);
  const initial = installArtifact(firstArtifact, originalBundle);
  const invoke = (bundle, report) => {
    // Exact COMPANION-R8 argv; silent shared slot. No secret flags or home override.
    run(browserSlot, ['run', '--wait', '120', '--', join(bundle, 'Contents/MacOS/LuxDidi'), '--installed-proof', '--proof-state', proofState, '--proof-report', report], { env: scrubbedEnvironment(homedir()), stdio: ['ignore', 'pipe', 'pipe'] });
    refuseLive(bundle); // Exit0 alone is insufficient; actual owned app/service must stop.
    return reportAt(report);
  };
  const firstReport = invoke(originalBundle, join(reports, 'first.json'));
  // Native exclusively owns this same state directory. Never remove/reseed it here.
  const reinstall = installArtifact(reinstallArtifact, originalBundle);
  if (reinstall.installId !== initial.installId) throw new Error('Real reinstall changed install identity');
  const relocatedBundle = join(proofRoot, 'relocated', bundleName);
  mkdirSync(join(proofRoot, 'relocated'), { mode: 0o700 });
  renameSync(originalBundle, relocatedBundle);
  renameSync(`${originalBundle}.receipt.json`, `${relocatedBundle}.receipt.json`);
  validateBundle(relocatedBundle, reinstall);
  if (existsSync(originalBundle)) throw new Error('Original installed bundle still exists after relocation');
  const secondReport = invoke(relocatedBundle, join(reports, 'second.json'));
  return {
    acceptance: 'PENDING_OWNING_DURABLE_REPORT_CONTRACT',
    proofState, originalBundle, relocatedBundle,
    firstInstallId: initial.installId, reinstallId: reinstall.installId,
    firstReport, secondReport,
  };
}
export function runBuiltInstalledReinstallProof({ build, workRoot, browserSlot }) {
  const info = lstatSync(workRoot);
  if (!isAbsolute(workRoot) || info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || readdirSync(workRoot).length) throw new Error('Build/proof work root must be an empty owned 0700 directory');
  workRoot = realpathSync(workRoot);
  const firstArtifact = join(workRoot, 'first-artifact');
  const reinstallArtifact = join(workRoot, 'reinstall-artifact');
  // Two actual compilations, not a rewritten manifest masquerading as a fresh artifact.
  buildArtifact({ ...build, output: firstArtifact });
  buildArtifact({ ...build, output: reinstallArtifact });
  const proofRoot = join(workRoot, 'proof');
  mkdirSync(proofRoot, { mode: 0o700 });
  return runInstalledReinstallProof({ firstArtifact, reinstallArtifact, proofRoot, browserSlot });
}
// No standalone success CLI: final check must compare the owning report's exact
// prior record IDs/text and capture/recall/cleanup outcomes once that API is accepted.
// The caller owns this disposable proof root and its cleanup; a failed native run
// is not authorization to erase state or terminate an unknown PID.
