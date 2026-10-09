import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Manifest = {name: string; version: string; dependencies?: Record<string,string>; optionalDependencies?: Record<string,string>; peerDependencies?: Record<string,string>; peerDependenciesMeta?: Record<string,{optional?: boolean}>; bundleDependencies?: string[]; dev?: boolean; license?: string};
type Lock = {packages: Record<string,Manifest>};
type Pack = {filename: string; size: number; unpackedSize: number; files: {path: string; size: number; mode: number}[]};
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = process.env.DIDI_PACKAGE_SOURCE;
const lock = JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8')) as Lock;
const manifest = JSON.parse(readFileSync(join(root,'package.json'),'utf8')) as Manifest;
const scratch = mkdtempSync(join(tmpdir(),'didi-artifact-'));
let packed: Pack;
let archive: string;
let extracted: string;

function command(program: string, args: string[], cwd = root, cache = join(scratch,'pack-cache')) {
  return spawnSync(program,args,{cwd,env:{...process.env,npm_config_cache:cache},encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024});
}
function run(program: string, args: string[], cwd = root): string {
  const result = command(program,args,cwd);
  assert.equal(result.status,0,`${program}: ${result.error?.message ?? ''}\n${result.stderr}`);
  return result.stdout;
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir,name);
    assert.ok(!lstatSync(path).isSymbolicLink(),`Unexpected symlink: ${path}`);
    return statSync(path).isDirectory() ? files(path) : [path];
  }).sort();
}
function dependencyPath(from: string, name: string): string | undefined {
  for (let base = from; ; base = dirname(base)) {
    const candidate = base === '.' || base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (base === '.' || base === '') return undefined;
  }
}
// Traverse the committed graph, including required peers, rather than trusting
// npm ci's reported count or an unrelated developer node_modules inventory.
function closure(): string[] {
  const visited = new Set<string>();
  function visit(path: string) {
    const entry = lock.packages[path]!;
    const dependencies = {...entry.dependencies,...entry.optionalDependencies,...entry.peerDependencies};
    for (const name of Object.keys(dependencies)) {
      const child = dependencyPath(path,name);
      const optional = name in (entry.optionalDependencies ?? {}) || entry.peerDependenciesMeta?.[name]?.optional;
      if (!child && optional) continue;
      assert.ok(child,`Missing locked runtime dependency ${name} from ${path}`);
      assert.ok(!lock.packages[child]!.dev,`Runtime dependency marked dev: ${child}`);
      if (!visited.has(child)) { visited.add(child); visit(child); }
    }
  }
  visit('');
  const result = [...visited].sort();
  assert.deepEqual(result,Object.keys(lock.packages).filter(path => path && !lock.packages[path]!.dev).sort(),'Lock production flags disagree with dependency closure');
  return result;
}
function packagePaths(base: string, prefix = 'node_modules'): string[] {
  const dir = join(base,prefix);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => !name.startsWith('.')).flatMap(name => {
    const paths = name.startsWith('@') ? readdirSync(join(dir,name)).map(child => `${prefix}/${name}/${child}`) : [`${prefix}/${name}`];
    return paths.flatMap(path => [path,...packagePaths(base,`${path}/node_modules`)]);
  }).sort();
}
function cleanRuntime(base: string) {
  assert.deepEqual(packagePaths(base),closure(),'Extraneous or missing runtime package');
  for (const path of closure()) {
    const actual = JSON.parse(readFileSync(join(base,path,'package.json'),'utf8')) as Manifest;
    assert.equal(actual.name, path.split('node_modules/').at(-1));
    assert.equal(actual.version,lock.packages[path]!.version,`Wrong version: ${path}`);
  }
}
function verify(base: string) {
  const metadata = JSON.parse(readFileSync(join(base,'package.json'),'utf8')) as Manifest;
  assert.deepEqual(metadata.bundleDependencies,Object.keys(manifest.dependencies ?? {}),'Missing runtime bundle declaration');
  cleanRuntime(base);
  const expectedService = ['package.json','adapters/mcp/SDK-LICENSE.txt',...files(join(root,'dist')).map(path => relative(root,path)).filter(path => !path.startsWith('dist/test/'))].sort();
  const actualFiles = files(base).map(path => relative(base,path));
  assert.deepEqual(actualFiles.filter(path => !path.startsWith('node_modules/')).sort(),expectedService,'Unexpected/missing service files');
  for (const path of expectedService) {
    assert.deepEqual(readFileSync(join(base,path)),readFileSync(join(root,path)),`Service byte mismatch: ${path}`);
    if (source && path.startsWith('dist/')) assert.deepEqual(readFileSync(join(base,path)),readFileSync(join(source,path)),`Builder byte mismatch: ${path}`);
  }
  for (const path of closure()) {
    const licenses = readdirSync(join(root,path)).filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name));
    assert.ok(licenses.length,`No upstream license file: ${path}`);
    for (const license of licenses) assert.deepEqual(readFileSync(join(base,path,license)),readFileSync(join(root,path,license)),`Missing/changed license: ${path}/${license}`);
  }
  assert.deepEqual(actualFiles.sort(),packed.files.map(file => file.path).sort(),'Changed archive inventory');
  for (const path of actualFiles) {
    // npm includes isexe's public .npmignore when bundling. It is legitimate
    // upstream packaging metadata, verified byte-for-byte below, not dotenv.
    assert.ok(!path.split('/').some(part => (part.startsWith('.') && !(path.startsWith('node_modules/') && part === '.npmignore')) || /^(secrets?|credentials?|private)$/i.test(part)),`Private/hidden content: ${path}`);
    assert.ok(!/\.node$/.test(path),`Unverified native runtime: ${path}`);
    if (path.startsWith('node_modules/')) assert.ok(readFileSync(join(base,path)).equals(readFileSync(join(root,path))),`Runtime byte mismatch: ${path}`);
  }
}
function unpack(tarball: string, name: string): string {
  const dir = join(scratch,name);
  mkdirSync(dir);
  const names = run('tar',['-tzf',tarball]).trim().split('\n');
  assert.equal(new Set(names).size,names.length,'Duplicate archive paths');
  assert.ok(names.every(path => path.startsWith('package/') && !path.split('/').includes('..')),'Unsafe archive path');
  run('tar',['-xzf',tarball,'-C',dir]);
  return join(dir,'package');
}
function altered(name: string, change: (base: string) => void): {base: string; tarball: string} {
  const base = unpack(archive,name);
  change(base);
  const tarball = join(scratch,`${name}.tgz`);
  run('tar',['-czf',tarball,'-C',dirname(base),'package']);
  return {base,tarball};
}
function install(tarball: string, name: string) {
  const dir = join(scratch,name);
  const cache = join(dir,'empty-cache');
  assert.ok(!existsSync(cache),'Target cache must start absent');
  const result = command('npm',['install','--prefix',dir,'--offline','--ignore-scripts','--omit=dev','--no-audit','--no-fund',tarball],root,cache);
  return {dir,result};
}

before(() => {
  cleanRuntime(root);
  packed = JSON.parse(run('npm',['pack','--json','--offline','--ignore-scripts','--pack-destination',scratch]))[0] as Pack;
  archive = join(scratch,packed.filename);
  extracted = unpack(archive,'original');
});
after(() => rmSync(scratch,{recursive:true,force:true}));

test('artifact matches locked runtime closure, compiled service, inventory and licenses', () => {
  cleanRuntime(root);
  verify(extracted);
  const inventory = files(extracted).map(path => ({path:relative(extracted,path),size:statSync(path).size,mode:statSync(path).mode & 0o777})).sort((a,b)=>a.path.localeCompare(b.path));
  assert.deepEqual(inventory,[...packed.files].sort((a,b)=>a.path.localeCompare(b.path)));
  assert.equal(statSync(archive).size,packed.size);
  assert.equal(inventory.reduce((sum,item)=>sum+item.size,0),packed.unpackedSize);
  const digest = createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
  console.log(`ARTIFACT ${JSON.stringify({name:packed.filename,node:process.version,platform:`${process.platform}/${process.arch}`,runtimePackages:closure().length,files:inventory.length,compressedBytes:packed.size,unpackedBytes:packed.unpackedSize,archiveSha256:createHash('sha256').update(readFileSync(archive)).digest('hex'),inventorySha256:digest,closure:closure().map(path=>({path,version:lock.packages[path]!.version,license:lock.packages[path]!.license,licenseFiles:readdirSync(join(root,path)).filter(name=>/^(licen[sc]e|copying|notice)([.-]|$)/i.test(name)),files:inventory.filter(file=>file.path.startsWith(`${path}/`)).length}))})}`);
});

test('artifact installed offline exposes and uses the real MCP adapter', async () => {
  const {dir,result} = install(archive,'adapter-install');
  assert.equal(result.status,0,result.stderr);
  const base = join(dir,'node_modules/@lux-didi/service/dist/adapters/mcp');
  assert.ok(existsSync(join(base,'adapter.js')),'Owning build omitted MCP adapter dist');
  const adapterModule = await import(pathToFileURL(join(base,'adapter.js')).href) as typeof import('../adapters/mcp/adapter.js');
  const registryModule = await import(pathToFileURL(join(base,'registry.js')).href) as typeof import('../adapters/mcp/registry.js');
  const storeModule = await import(pathToFileURL(join(base,'store.js')).href) as typeof import('../adapters/mcp/store.js');
  const adapter = adapterModule.createMcpAdapter({registry:new registryModule.McpRegistry(),store:new storeModule.MemoryResultStore()});
  const discovery = await adapter.discover('unconfigured');
  assert.equal(discovery.state,'unavailable');
  if (discovery.state === 'unavailable') assert.ok(discovery.reason.length > 0);
  await adapter.close();
  assert.deepEqual(await adapter.discover('unconfigured'),{state:'unavailable',reason:'adapter-closed'});
});

test('artifact negative: absent bundle fails inventory and empty-cache offline install', () => {
  const broken = altered('no-bundle',base => {
    const metadata = JSON.parse(readFileSync(join(base,'package.json'),'utf8')) as Manifest;
    delete metadata.bundleDependencies;
    writeFileSync(join(base,'package.json'),JSON.stringify(metadata));
    rmSync(join(base,'node_modules'),{recursive:true,force:true});
  });
  assert.throws(()=>verify(broken.base),/Missing runtime bundle declaration/);
  const {result} = install(broken.tarball,'no-bundle-install');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/ENOTCACHED/);
});

test('artifact negative: missing required package fails inventory and installed adapter use', () => {
  const broken = altered('missing-package',base => rmSync(join(base,'node_modules/zod'),{recursive:true,force:true}));
  assert.throws(()=>verify(broken.base),/Extraneous or missing runtime package/);
  const {dir,result} = install(broken.tarball,'missing-install');
  if (result.status !== 0) assert.match(result.stderr,/ENOTCACHED/);
  else {
    const loaded = command(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(join(dir,'node_modules/@lux-didi/service/dist/adapters/mcp/adapter.js')).href)})`]);
    assert.notEqual(loaded.status,0,'Missing runtime package unexpectedly loaded');
    assert.match(loaded.stderr,/ERR_MODULE_NOT_FOUND|Cannot find/);
  }
});

test('artifact negative: tampered version and inventory are rejected', () => {
  const changed = altered('wrong-version',base => {
    const path = join(base,'node_modules/@modelcontextprotocol/client/package.json');
    const metadata = JSON.parse(readFileSync(path,'utf8')) as Manifest;
    metadata.version = '0.0.0';
    writeFileSync(path,JSON.stringify(metadata));
  });
  assert.throws(()=>verify(changed.base),/Wrong version/);
  const extra = altered('private-file',base => writeFileSync(join(base,'.env'),'SYNTHETIC=not-a-secret\n'));
  assert.throws(()=>verify(extra.base),/Unexpected\/missing service files|Private\/hidden content/);
  const runtimeFile = files(join(root,'node_modules/@modelcontextprotocol/client')).find(path => /\.[cm]?js$/.test(path))!;
  const absent = altered('missing-runtime-file',base => rmSync(join(base,relative(root,runtimeFile))));
  assert.throws(()=>verify(absent.base),/Changed archive inventory/);
  const tampered = altered('tampered-runtime-file',base => writeFileSync(join(base,relative(root,runtimeFile)),'/* synthetic tampering */\n'));
  assert.throws(()=>verify(tampered.base),/Runtime byte mismatch/);
});

test('artifact negative: polluted input tree is rejected before it can be trusted', () => {
  const extra = join(root,'node_modules/didi-extraneous-control');
  assert.ok(!existsSync(extra));
  try {
    mkdirSync(extra);
    writeFileSync(join(extra,'package.json'),JSON.stringify({name:'didi-extraneous-control',version:'0.0.0'}));
    assert.throws(()=>cleanRuntime(root),/Extraneous or missing runtime package/);
  } finally { rmSync(extra,{recursive:true,force:true}); }
  cleanRuntime(root);
});
