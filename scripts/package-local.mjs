#!/usr/bin/env node
// Local development packaging only. No downloading, runtime shell, or app launch.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const bundleName = 'LuxDidi.app';
export const resourceRoot = 'Contents/Resources';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const commitPattern = /^[a-f0-9]{40}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const forbidden = /(^|\/)(\.env(?:\.[^/]*)?|\.git|private-state|appdata|secrets|admin-credential|localadmin-credential|runtime\.json)(\/|$)|\.(sqlite|sqlite3|db|key|pem)(?:$|-)/i;
export function scrubbedEnvironment(home) {
  return { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'C', LC_ALL: 'C', CI: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' };
}
export function run(file, argv, options = {}) {
  try {
    return execFileSync(file, argv, { encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024, ...options });
  } catch (error) {
    // Do not relay arbitrary compiler/process environment or credential-bearing output.
    throw new Error(`${file.split('/').pop()} failed (status ${error.status ?? error.code})`, { cause: error });
  }
}
export function probeNode(input) {
  const home = mkdtempSync(join(tmpdir(), 'didi-node-probe-'));
  try {
    if (!isAbsolute(input ?? '')) throw new Error('Node requires an explicit absolute executable');
    const path = realpathSync(input);
    if (!statSync(path).isFile()) throw new Error('Node must be a regular executable');
    accessSync(path, constants.X_OK);
    const output = run(path, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); const ok=db.prepare('select 42 as n').get().n===42; db.close(); console.log(JSON.stringify({version:process.version,major:Number(process.versions.node.split('.')[0]),sqlite:ok,path:process.execPath,platform:process.platform,arch:process.arch}));`], { env: scrubbedEnvironment(home), stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(output);
    if (result.major !== 26 || !/^v26\./.test(result.version)) throw new Error('Node 26 is required (exact major)');
    if (!result.sqlite || result.platform !== 'darwin' || realpathSync(result.path) !== path) throw new Error('Node executable/SQLite process probe failed');
    const linkage = run('/usr/bin/otool', ['-L', path], { env: scrubbedEnvironment(home) }).trim().split('\n').slice(1).map(line => line.trim());
    if (!linkage.length) throw new Error('Node dylib probe failed');
    return { ...result, path, linkage, sha256: sha(readFileSync(path)) };
  } catch (error) {
    throw new Error(`Node prerequisite: ${error.message}`, { cause: error });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

export function inventory(root) {
  const entries = [];
  function visit(path, name) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`symlink forbidden: ${name || '.'}`);
    if (name && forbidden.test(name)) throw new Error(`forbidden runtime inclusion: ${name}`);
    if (info.isDirectory()) {
      if (name) entries.push({ path: name, type: 'directory', mode: info.mode & 0o777 });
      for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
    } else if (info.isFile()) {
      entries.push({ path: name, type: 'file', mode: info.mode & 0o777, size: info.size, sha256: sha(readFileSync(path)) });
    } else throw new Error(`nonregular runtime inclusion: ${name}`);
  }
  visit(root, '');
  return entries;
}
export function checkPrerequisites(source) {
  if (!existsSync(join(source, 'server/host/index.ts'))) throw new Error('Accepted HOST entry server/host/index.ts is missing; root-delivered accepted HOST main required');
  const native = join(source, 'Sources/LuxDidi');
  const text = existsSync(native) ? readdirSync(native).filter(name => name.endsWith('.swift')).map(name => readFileSync(join(native, name), 'utf8')).join('\n') : '';
  if (!text.includes('didi-runtime.json') || !text.includes('installId')) throw new Error('Accepted COMPANION installed-mode capability is missing; root-delivered accepted COMPANION-R7 main required');
  // This gate detects absence, not proof of behavior. Relocated startup is a separate gate.
}
export function validateBundle(bundle, metadata, { sourceCommit, checkNode = true } = {}) {
  if (metadata.schemaVersion !== 1 || metadata.artifactType !== 'lux-didi-local-development' || !commitPattern.test(metadata.releaseCommit) || metadata.signingIdentity !== 'ad-hoc') throw new Error('Invalid artifact identity');
  if (sourceCommit && sourceCommit !== metadata.releaseCommit) throw new Error('Artifact source identity mismatch');
  const actual = inventory(bundle);
  if (JSON.stringify(actual) !== JSON.stringify(metadata.inventory)) throw new Error('Artifact inventory mismatch');
  const identifier = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')]).trim();
  const executable = run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')]).trim();
  if (identifier !== 'ai.peat.lux-didi' || executable !== 'LuxDidi') throw new Error('Unrelated app identity');
  const resources = join(bundle, resourceRoot);
  const runtime = JSON.parse(readFileSync(join(resources, 'didi-runtime.json'), 'utf8'));
  const keys = ['schemaVersion', 'installId', 'releaseCommit', 'nodePath', 'nodeMajor', 'serverEntry', 'webRoot'];
  if (Object.keys(runtime).sort().join() !== keys.sort().join() || runtime.schemaVersion !== 1 || !uuidPattern.test(runtime.installId) || runtime.installId !== metadata.installId || runtime.releaseCommit !== metadata.releaseCommit || runtime.nodeMajor !== 26 || !isAbsolute(runtime.nodePath) || runtime.serverEntry !== 'server/dist/host/index.js' || runtime.webRoot !== 'web/dist') throw new Error('Runtime schema/identity mismatch');
  for (const path of [runtime.serverEntry, `${runtime.webRoot}/index.html`, 'LuxDidi.entitlements']) {
    if (!existsSync(join(resources, path)) || !lstatSync(join(resources, path)).isFile()) throw new Error(`Required host/web/resource asset missing: ${path}`);
  }
  accessSync(join(bundle, 'Contents/MacOS/LuxDidi'), constants.X_OK);
  run('/usr/bin/codesign', ['--verify', '--strict', bundle], { stdio: 'pipe' });
  const signing = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', bundle], { encoding: 'utf8', timeout: 10000 });
  if (signing.status !== 0 || !/Signature=adhoc/.test(signing.stderr)) throw new Error('Native signing identity is not ad-hoc');
  // Ad-hoc signatures prove inventory integrity, not trusted publisher provenance.
  if (checkNode) {
    const node = probeNode(runtime.nodePath);
    if (node.path !== metadata.node?.path || node.sha256 !== metadata.node?.sha256 || node.version !== metadata.node?.version || JSON.stringify(node.linkage) !== JSON.stringify(metadata.node?.linkage)) throw new Error('Node prerequisite identity changed; rebuild explicitly');
  }
  return { bundle, metadata, runtime };
}
export function validateArtifact(directory, options) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Artifact symlink forbidden');
  const metadataPath = join(directory, 'artifact.json');
  if (!lstatSync(metadataPath).isFile() || lstatSync(metadataPath).isSymbolicLink()) throw new Error('Artifact metadata must be a regular file');
  return validateBundle(join(directory, bundleName), JSON.parse(readFileSync(metadataPath, 'utf8')), options);
}
export function signBundle(bundle) {
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', join(bundle, resourceRoot, 'LuxDidi.entitlements'), bundle], { stdio: 'pipe' });
  run('/usr/bin/codesign', ['--verify', '--strict', bundle], { stdio: 'pipe' });
}
function copyRuntimeTree(source, target, filter = () => true) {
  inventory(source); // Never dereference a dependency/output symlink.
  cpSync(source, target, { recursive: true, dereference: false, filter });
}
function verifySource(source, sourceCommit) {
  const head = run('/usr/bin/git', ['-C', source, 'rev-parse', 'HEAD']).trim();
  if (!commitPattern.test(sourceCommit ?? '') || head !== sourceCommit) throw new Error('Exact clean source HEAD 40hex is required');
  if (run('/usr/bin/git', ['-C', source, 'status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('Source must be clean before packaging');
  return head;
}
export function buildArtifact({ source, sourceCommit, output, nodePath, npmCli, npmCache }) {
  if (process.platform !== 'darwin') throw new Error('This target requires macOS');
  const root = realpathSync(source);
  const head = verifySource(root, sourceCommit);
  checkPrerequisites(root);
  const node = probeNode(nodePath);
  if (!isAbsolute(npmCli ?? '') || !isAbsolute(npmCache ?? '') || !statSync(npmCli).isFile() || !statSync(npmCache).isDirectory()) throw new Error('Explicit existing npm CLI and offline cache required');
  output = resolve(output);
  mkdirSync(dirname(output), { recursive: true });
  const parent = realpathSync(dirname(output));
  const rel = relative(root, parent);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('Artifact must be outside the source checkout');
  output = join(parent, output.split(sep).pop());
  if (existsSync(output)) throw new Error('Output already exists; never overwrite an artifact');
  const stage = mkdtempSync(join(parent, '.didi-package-'));
  try {
    const checkout = join(stage, 'source');
    const home = join(stage, 'home');
    mkdirSync(checkout); mkdirSync(home);
    const env = scrubbedEnvironment(home);
    const archive = execFileSync('/usr/bin/git', ['-C', root, 'archive', '--format=tar', head], { timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
    execFileSync('/usr/bin/tar', ['-xf', '-', '-C', checkout], { input: archive, timeout: 30000 });
    const bundle = join(stage, bundleName);
    const resources = join(bundle, resourceRoot);
    mkdirSync(resources, { recursive: true }); mkdirSync(join(bundle, 'Contents/MacOS'));
    for (const project of ['server', 'web']) {
      const cwd = join(checkout, project);
      run(node.path, [npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache], { cwd, env });
      run(node.path, [join(cwd, 'node_modules/typescript/bin/tsc'), ...(project === 'server' ? ['-p', 'tsconfig.json'] : ['--noEmit'])], { cwd, env });
      if (project === 'web') run(node.path, [join(cwd, 'node_modules/vite/bin/vite.js'), 'build'], { cwd, env });
    }
    if (!existsSync(join(checkout, 'server/dist/host/index.js')) || !existsSync(join(checkout, 'web/dist/index.html'))) throw new Error('Actual compiled HOST/web assets missing');
    copyRuntimeTree(join(checkout, 'server/dist'), join(resources, 'server/dist'), path => !relative(join(checkout, 'server/dist'), path).split(sep).includes('test') && (!lstatSync(path).isFile() || path.endsWith('.js')));
    copyRuntimeTree(join(checkout, 'web/dist'), join(resources, 'web/dist'));
    const server = join(checkout, 'server');
    run(node.path, [npmCli, 'ci', '--omit=dev', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache], { cwd: server, env });
    rmSync(join(server, 'node_modules/.bin'), { recursive: true, force: true });
    copyRuntimeTree(join(server, 'node_modules'), join(resources, 'server/node_modules'));
    cpSync(join(server, 'package.json'), join(resources, 'server/package.json'));
    const license = join(server, 'adapters/mcp/SDK-LICENSE.txt');
    if (existsSync(license)) { mkdirSync(join(resources, 'server/adapters/mcp'), { recursive: true }); cpSync(license, join(resources, 'server/adapters/mcp/SDK-LICENSE.txt')); }
    cpSync(join(checkout, 'Resources/Info.plist'), join(bundle, 'Contents/Info.plist'));
    cpSync(join(checkout, 'Resources/LuxDidi.entitlements'), join(resources, 'LuxDidi.entitlements'));
    const swift = readdirSync(join(checkout, 'Sources/LuxDidi')).filter(name => name.endsWith('.swift')).sort().map(name => join(checkout, 'Sources/LuxDidi', name));
    run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(stage, 'cache'), '-parse-as-library', ...swift, '-o', join(bundle, 'Contents/MacOS/LuxDidi')], { env });
    const runtime = { schemaVersion: 1, installId: randomUUID(), releaseCommit: head, nodePath: node.path, nodeMajor: 26, serverEntry: 'server/dist/host/index.js', webRoot: 'web/dist' };
    writeFileSync(join(resources, 'didi-runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
    signBundle(bundle);
    const metadata = { schemaVersion: 1, artifactType: 'lux-didi-local-development', releaseCommit: head, installId: runtime.installId, node, signingIdentity: 'ad-hoc', lockHashes: Object.fromEntries(['server', 'web'].map(project => [project, sha(readFileSync(join(checkout, project, 'package-lock.json')))])), inventory: inventory(bundle), limitations: 'Target-specific existing Node 26 prerequisite; not Developer ID, notarized, universal or self-contained.' };
    writeFileSync(join(stage, 'artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    validateArtifact(stage, { sourceCommit: head });
    rmSync(checkout, { recursive: true }); rmSync(home, { recursive: true }); rmSync(join(stage, 'cache'), { recursive: true, force: true });
    renameSync(stage, output);
    return { output, releaseCommit: head, installId: runtime.installId };
  } finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
}
export function parseArguments(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!allowed.includes(flag) || flag in result) throw new Error(`Unknown or duplicate option: ${flag}`);
    if (flag === '--help' || flag === '--check-prerequisites') result[flag] = true;
    else { const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error(`Value required: ${flag}`); result[flag] = value; }
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2), ['--help', '--check-prerequisites', '--source-commit', '--node', '--output', '--npm-cli', '--npm-cache']);
    const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    if (args['--help']) console.log('package-local --node /absolute/node26 --npm-cli /absolute/npm-cli.js --npm-cache /existing/offline/cache --output /outside/checkout/artifact --source-commit <clean-HEAD-40hex>\npackage-local --check-prerequisites --source-commit <HEAD>');
    else if (args['--check-prerequisites']) { verifySource(source, args['--source-commit']); checkPrerequisites(source); console.log('PACKAGE prerequisite capabilities present; relocated startup proof still required'); }
    else {
      if (!args['--output']) throw new Error('--output is required');
      console.log(JSON.stringify(buildArtifact({ source, sourceCommit: args['--source-commit'], nodePath: args['--node'], output: args['--output'], npmCli: args['--npm-cli'], npmCache: args['--npm-cache'] })));
    }
  } catch (error) { console.error(`PACKAGE REFUSED: ${error.message}`); process.exitCode = 1; }
}
