#!/usr/bin/env python3
"""Exercise npm's real offline target selection without network or shared cache."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

repo = Path(__file__).resolve().parent.parent
helper = repo / 'scripts/npm-ci-offline.sh'

def require(condition, message):
    if not condition:
        raise AssertionError(message)

def invoke(target, *arguments, cache, relative=True):
    user_config, global_config = cache.parent / 'user.npmrc', cache.parent / 'global.npmrc'
    user_config.touch()
    global_config.touch()
    env = dict(os.environ, npm_config_cache=str(cache), npm_config_userconfig=str(user_config),
               npm_config_globalconfig=str(global_config), npm_config_registry='http://127.0.0.1:9',
               npm_config_update_notifier='false')
    argument = os.path.relpath(target, repo) if relative else str(target)
    return subprocess.run(['bash', str(helper), argument, *arguments],
                          cwd=repo, env=env, text=True, capture_output=True)

with tempfile.TemporaryDirectory(prefix='didi-npm-target-') as temporary:
    root = Path(temporary).resolve()
    ancestor = root / 'ancestor'
    target = ancestor / 'empty child' / 'runtime'
    target.mkdir(parents=True)
    external = root / 'protected modules'
    external.mkdir()
    (external / 'sentinel').write_text('external sentinel stays unchanged\n')
    (ancestor / 'node_modules').symlink_to(external, target_is_directory=True)
    (ancestor / 'package.json').write_text('{"name":"ancestor-sentinel","version":"1.0.0","private":true}\n')
    (ancestor / 'package-lock.json').write_text('{"name":"ancestor-sentinel","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"ancestor-sentinel","version":"1.0.0"}}}\n')
    before = {name: (ancestor / name).read_bytes() for name in ['package.json', 'package-lock.json']}
    link_before = (ancestor / 'node_modules').lstat()
    external_before = (external / 'sentinel').read_bytes()
    tarball = root / 'tiny-local-1.0.0.tgz'
    manifest = {'name': 'tiny-local', 'version': '1.0.0', 'main': 'index.js',
                'scripts': {'install': 'node -e "throw new Error(\'install scripts must be ignored\')"'}}
    with tarfile.open(tarball, 'w:gz') as archive:
        for name, data in [('package/package.json', json.dumps(manifest).encode()),
                           ('package/index.js', b'module.exports = "local offline payload";\n')]:
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(data))
    cache = root / 'cache'
    installed = invoke(target, 'install', '--offline', '--omit=dev', '--ignore-scripts',
                       '--no-audit', '--no-fund', str(tarball), cache=cache)
    require(installed.returncode == 0, 'local offline install failed: ' + installed.stderr)
    require((target / 'node_modules/tiny-local/index.js').is_file(),
            'offline tarball escaped empty child target')
    for name, data in before.items():
        require((ancestor / name).read_bytes() == data, 'ancestor ' + name + ' changed')
    link_after = (ancestor / 'node_modules').lstat()
    require((ancestor / 'node_modules').is_symlink(), 'ancestor node_modules link replaced')
    require((link_before.st_dev, link_before.st_ino) == (link_after.st_dev, link_after.st_ino),
            'ancestor node_modules link identity changed')
    require(os.readlink(ancestor / 'node_modules') == str(external), 'ancestor link target changed')
    require((external / 'sentinel').read_bytes() == external_before, 'external sentinel changed')
    require(sorted(p.name for p in external.iterdir()) == ['sentinel'], 'external dependencies changed')
    print('PASS: relative empty child with spaces receives offline tarball; ancestor files/link/external target unchanged', flush=True)
    shutil.rmtree(target / 'node_modules')
    default = invoke(target, cache=cache)
    require(default.returncode == 0, 'default offline ci failed: ' + default.stderr)
    require((target / 'node_modules/tiny-local/index.js').is_file(), 'default ci missed target')
    print('PASS: default offline ci reuses only the private warmed cache', flush=True)
    absolute = ancestor / 'another empty child'
    absolute.mkdir()
    installed_absolute = invoke(absolute, 'install', '--offline', '--omit=dev', '--ignore-scripts',
                                '--no-audit', '--no-fund', str(tarball), cache=cache, relative=False)
    require(installed_absolute.returncode == 0, 'absolute offline install failed: ' + installed_absolute.stderr)
    require((absolute / 'node_modules/tiny-local/index.js').read_bytes() ==
            (target / 'node_modules/tiny-local/index.js').read_bytes(), 'absolute target payload differs')
    print('PASS: absolute empty child receives the exact same local tarball payload', flush=True)
    missing = ancestor / 'missing cache runtime'
    missing.mkdir()
    dependency = 'offline-target-fixture'
    package = {'name': 'missing-cache-runtime', 'version': '1.0.0', 'dependencies': {dependency: '1.0.0'}}
    (missing / 'package.json').write_text(json.dumps(package))
    lock = {'name': package['name'], 'version': '1.0.0', 'lockfileVersion': 3,
            'packages': {'': package, 'node_modules/' + dependency: {
                'version': '1.0.0', 'resolved': 'http://127.0.0.1:9/' + dependency + '/-/' + dependency + '-1.0.0.tgz',
                'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(b'absent synthetic package').digest()).decode()}}}
    (missing / 'package-lock.json').write_text(json.dumps(lock))
    failed = invoke(missing, cache=root / 'empty-cache')
    require(failed.returncode != 0, 'empty cache unexpectedly succeeded')
    require('ENOTCACHED' in failed.stderr, 'offline error code lost')
    require('missing offline-target-fixture@1.0.0' in failed.stderr, 'missing tarball identity lost')
    require('warm-npm-cache.sh' in failed.stderr, 'warm-cache repair guidance lost')
    require(str(missing) in failed.stderr or os.path.relpath(missing, repo) in failed.stderr,
            'failure target diagnostic lost')
    for name, data in before.items():
        require((ancestor / name).read_bytes() == data, 'later operation changed ancestor ' + name)
    final_link = (ancestor / 'node_modules').lstat()
    require((ancestor / 'node_modules').is_symlink() and
            (final_link.st_dev, final_link.st_ino) == (link_before.st_dev, link_before.st_ino),
            'later operation replaced ancestor dependency link')
    require((external / 'sentinel').read_bytes() == external_before and
            sorted(p.name for p in external.iterdir()) == ['sentinel'], 'later operation changed external target')
    print('PASS: empty cache remains nonzero with ENOTCACHED, exact missing package and repair command; ancestor unchanged', flush=True)
print('TEST-NPM-OFFLINE-TARGET PASS')
