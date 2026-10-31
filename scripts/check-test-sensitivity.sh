#!/usr/bin/env bash
# Test sensitivity: a test that cannot fail is not a test. Each sidecar in server/test/sensitivity/ names
# the production file, one small mutant (return early, flip a comparison, drop the dispatch registration)
# and the test that MUST fail under it. The runner applies the mutant in a temp copy of the tree, runs
# only that test, and fails when the test still passes.
#
#   scripts/check-test-sensitivity.sh                    # every sidecar that resolves in this tree
#   scripts/check-test-sensitivity.sh --only <name>      # one sidecar (repeatable)
#   scripts/check-test-sensitivity.sh --selftest         # the runner's own fixtures: a test that cannot
#                                                        # fail must be reported, one that can must pass
#   scripts/check-test-sensitivity.sh --sidecars <dir>   # sidecars from another directory
#
# A sidecar is skipped when its test file is not in this tree at all (the clean-quit sidecar belongs to
# the combined release tree), and --require-all turns that skip into a failure. Baseline first: a test
# already red proves nothing about a mutant. See docs/evals.md for the format.
#
# Boundaries: no network, no provider call, no audio, no app launch, synthetic fixtures only.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"

run_sidecars() {
python3 - "$root" "$@" <<'PY'
import contextlib, io, json, os, shutil, subprocess, sys, tempfile

root = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else 'run'
args = sys.argv[3:]
sidecars = os.path.join(root, 'server', 'test', 'sensitivity')
only, require_all = [], False
# Flags are scanned across every argument, so `--only <name>` works whether it precedes or follows
# the mode word.
for i, value in enumerate([mode] + args):
    if value == '--only':
        only.append(([mode] + args)[i + 1])
    elif value == '--require-all':
        require_all = True
    elif value == '--sidecars':
        sidecars = os.path.abspath(([mode] + args)[i + 1])


def command(argv, cwd, env=None, timeout=900):
    merged = dict(os.environ)
    merged.update(env or {})
    return subprocess.run(argv, cwd=cwd, env=merged, capture_output=True, text=True, timeout=timeout)


def build(project, cache):
    """One compile per tsconfig per run: a mutant only needs the compiled tree it will run against."""
    if project in cache:
        return cache[project]
    server_dir = os.path.join(root, 'server')
    deps = os.environ.get('DIDI_TYPESCRIPT_ROOT', os.path.join(server_dir, 'node_modules'))
    tsc = os.path.join(deps, 'typescript', 'bin', 'tsc')
    if not os.path.isfile(tsc):
        raise SystemExit('SENSITIVITY BLOCKED: the server dependencies (typescript) are not installed; '
                         'run npm ci in server/')
    built = command(['node', tsc, '-p', project], server_dir, timeout=1800)
    if built.returncode != 0:
        raise SystemExit(f'SENSITIVITY BLOCKED: tsc -p {project} failed in this tree:\n'
                         + '\n'.join(built.stdout.splitlines()[-12:] + built.stderr.splitlines()[-12:]))
    cache[project] = os.path.join(server_dir, 'dist')
    return cache[project]


def tracked_files():
    listing = subprocess.run(['git', '-C', root, 'ls-files', '-z', '-co', '--exclude-standard'],
                             capture_output=True)
    return [p.decode() for p in listing.stdout.split(b'\0') if p]


def tree_copy():
    """A temp copy of the tracked tree (plus untracked files git does not ignore): the mutant is
    applied there, never in the worktree."""
    work = tempfile.mkdtemp(prefix='didi-sensitivity-')
    for path in tracked_files():
        source = os.path.join(root, path)
        if not os.path.isfile(source):
            continue
        target = os.path.join(work, path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(source, target)
    return work


def dist_copy(sidecar, builds):
    """A copy of the compiled tree inside the repository's git-ignored eval-out: node then resolves
    server/node_modules from it exactly as eval-mutation-probe.sh does."""
    built = build(sidecar['build'][0], builds)
    work = os.path.join(root, 'server', 'eval-out', 'sensitivity-' + sidecar['name'])
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    shutil.copytree(built, os.path.join(work, 'dist'))
    return work


def apply_mutant(work, sidecar, target):
    if target == 'dist':
        path = os.path.join(work, sidecar['compiled'])
    else:
        path = os.path.join(work, sidecar['production'])
    with open(path, encoding='utf-8') as handle:
        text = handle.read()
    find, replace = sidecar['mutant']['find'], sidecar['mutant']['replace']
    if text.count(find) != 1:
        return f'the mutant did not apply: its anchor appears {text.count(find)} times in {path}'
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(text.replace(find, replace))
    return None


def run_one(sidecar, builds):
    test_file = os.path.join(root, sidecar['test']['file'])
    if not os.path.isfile(test_file):
        return 'SKIP', f"{sidecar['test']['file']} is not in this tree"
    target = sidecar.get('target', 'dist')
    work = dist_copy(sidecar, builds) if target == 'dist' else tree_copy()
    cwd = os.path.join(work, sidecar.get('workdir', '.'))
    env = {key: value for key, value in sidecar.get('env', {}).items()}
    if 'DIDI_EVAL_SOURCE_ROOT' in env:
        env['DIDI_EVAL_SOURCE_ROOT'] = os.path.join(root, sidecar['env']['DIDI_EVAL_SOURCE_ROOT'])
    try:
        for source, target_path in sidecar.get('assets', []):
            destination = os.path.join(work, target_path)
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            shutil.copy2(os.path.join(root, source), destination)
        baseline = command(sidecar['command'], cwd, env)
        if baseline.returncode != 0:
            tail = (baseline.stdout + baseline.stderr).strip().splitlines()[-4:]
            return 'FAIL', 'the unmutated test is already red, so it cannot prove a mutant: ' \
                + ' / '.join(line.strip()[:160] for line in tail)
        if target == 'dist' and sidecar['test']['name'] not in (baseline.stdout + baseline.stderr):
            return 'FAIL', f"the named test {sidecar['test']['name']!r} never ran in the baseline"
        problem = apply_mutant(work, sidecar, target)
        if problem:
            return 'FAIL', problem
        mutated = command(sidecar['command'], cwd, env)
        if mutated.returncode == 0:
            return 'FAIL', f"the test passed under the mutant: {sidecar['mutant'].get('note', 'no note')}"
        return 'PASS', 'the mutant makes the named test fail'
    finally:
        shutil.rmtree(work, ignore_errors=True)


def load(directory):
    found = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(directory, name), encoding='utf-8') as handle:
            found.append((name, json.load(handle)))
    return found


def main():
    selected = [(name, sidecar) for name, sidecar in load(sidecars) if not only or sidecar['name'] in only]
    if not selected:
        print(f'SENSITIVITY BLOCKED: no sidecar in {sidecars}', file=sys.stderr)
        return 2
    builds, rows, failed, skipped = {}, [], 0, 0
    for name, sidecar in selected:
        verdict, detail = run_one(sidecar, builds)
        rows.append(f"| `{sidecar['name']}` | {verdict} | {detail} |")
        print(f"SENSITIVITY {verdict} {sidecar['name']}: {detail}")
        failed += verdict == 'FAIL'
        skipped += verdict == 'SKIP'
    summary = os.environ.get('DIDI_CHECK_SUMMARY', os.path.join(tempfile.gettempdir(), 'didi-sensitivity.md'))
    with open(summary, 'w', encoding='utf-8') as handle:
        handle.write('# Test sensitivity\n\n| sidecar | verdict | detail |\n| --- | --- | --- |\n')
        handle.write('\n'.join(rows) + '\n')
    print(f'SENSITIVITY summary {summary}')
    if require_all and skipped:
        print(f'SENSITIVITY FAILED: {skipped} sidecar(s) did not resolve in this tree', file=sys.stderr)
        return 1
    if failed:
        print(f'SENSITIVITY FAILED: {failed} sidecar(s) did not feel the mutant', file=sys.stderr)
        return 1
    print(f'SENSITIVITY PASSED: {len(selected) - skipped} sidecar(s) felt their mutant, {skipped} skipped')
    return 0


def selftest():
    """The runner must report a test that cannot fail, and pass one that can."""
    fixtures = os.path.join(sidecars, 'fixtures')
    status = 0
    for name, expected in (('cannot-fail', 'FAIL'), ('can-fail', 'PASS')):
        outcome = main_for(os.path.join(fixtures, name))
        if outcome != expected:
            print(f'SELFTEST FAIL: the {name} fixture was reported {outcome}, expected {expected}')
            status = 1
    if status == 0:
        print('SELFTEST PASSED: a test that cannot fail is caught, a test that can fail passes')
    return status


def main_for(directory):
    """The fixture run's own output is expected to be red: keep it out of the selftest transcript."""
    global sidecars
    saved, sidecars = sidecars, directory
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            code = main()
        return 'FAIL' if code != 0 else 'PASS'
    finally:
        sidecars = saved


if mode == '--selftest':
    raise SystemExit(selftest())
raise SystemExit(main())
PY
}

case "${1:-}" in
  -h|--help)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

run_sidecars "$@"
