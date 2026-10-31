#!/usr/bin/env bash
# The combined-tree gate: run every check that covers the files a release branch changed, and prove
# statically that each check script still stages or compiles the changed sources its targets import.
#
#   scripts/check-combined-tree.sh <base> <head>            # map, static passes, then the check union
#   scripts/check-combined-tree.sh <base> <head> --static   # the two static passes only (no check runs)
#   scripts/check-combined-tree.sh --selftest               # the gate's own fixtures, no repository state
#
# The two static passes exist for the class of break a per-wagon gate cannot see: two wagons green
# alone, red together, because a check script's staging list or a Swift compile unit does not name a
# file another wagon added. Both passes read the head tree out of git, so any pair of shas can be
# replayed from any worktree without a checkout.
#
# The summary is Markdown on stdout and, when DIDI_CHECK_SUMMARY names a path, in that file, so the
# overnight run can attach it. Nothing here touches the network.
#
# Boundaries: no app launch, no accessibility, no audio, no real provider, no owner data.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"

# The analysis is one embedded Python program: the path-to-check map, the TypeScript import graph,
# the Swift declaration references and the plist key whitelist. Bash owns the check loop.
analysis() {
python3 - "$root" "$@" <<'PY'
import json, os, plistlib, re, shlex, shutil, subprocess, sys, tempfile

root = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else ''
args = sys.argv[3:]


def git(*argv):
    return subprocess.run(['git', '-C', root, *argv], capture_output=True, text=True)


class Tree:
    """A head tree read from git, or a directory, with the same read() interface."""

    def __init__(self, sha=None, path=None, dirs=None):
        self.sha, self.path, self.cache = sha, path, {}
        if sha:
            listing = git('ls-tree', '-r', '--name-only', sha)
            if listing.returncode != 0:
                raise SystemExit(f'COMBINED FAILED: cannot read tree {sha}: {listing.stderr.strip()}')
            self.files = [line for line in listing.stdout.splitlines() if line]
            return
        self.files = []
        for base, subdirs, names in os.walk(path):
            subdirs[:] = [d for d in subdirs if d not in {'.git', 'node_modules', 'dist', 'eval-out'}]
            rel = os.path.relpath(base, path)
            for name in names:
                self.files.append(os.path.normpath(os.path.join(rel, name)))
        if dirs:
            self.files = [f for f in self.files if f.split(os.sep)[0] in dirs]
        self.files.sort()

    def read(self, path):
        if path in self.cache:
            return self.cache[path]
        if self.sha:
            shown = git('show', f'{self.sha}:{path}')
            text = shown.stdout if shown.returncode == 0 else None
        else:
            full = os.path.join(self.path, path)
            try:
                text = open(full, encoding='utf-8', errors='replace').read() if os.path.isfile(full) else None
            except OSError:
                text = None
        self.cache[path] = text
        return text


def glob_re(pattern):
    out, i = ['^'], 0
    while i < len(pattern):
        c = pattern[i]
        if c == '*':
            if pattern[i:i + 2] == '**':
                i += 2
                if pattern[i:i + 1] == '/':
                    i += 1
                out.append('.*')
                continue
            out.append('[^/]*')
            i += 1
            continue
        if c == '?':
            out.append('[^/]')
            i += 1
            continue
        out.append(re.escape(c))
        i += 1
    out.append('$')
    return re.compile(''.join(out))


def matches(pattern, path):
    return glob_re(pattern).match(path) is not None


def check_map():
    with open(os.path.join(root, 'config', 'check-map.json'), encoding='utf-8') as handle:
        return json.load(handle)['entries']


def checks_for(paths):
    entries = check_map()
    out = []
    for path in paths:
        for entry in entries:
            if any(matches(pattern, path) for pattern in entry['paths']):
                for check in entry['checks']:
                    if check not in out:
                        out.append(check)
    return out


def changed_files(base, head):
    diff = git('diff', '--name-only', '--diff-filter=ACMR', base, head)
    if diff.returncode != 0:
        raise SystemExit(f'COMBINED FAILED: cannot diff {base}..{head}: {diff.stderr.strip()}')
    return [line for line in diff.stdout.splitlines() if line]


def expand(tree_files, token):
    if any(ch in token for ch in '*?'):
        return [f for f in tree_files if matches(token, f)]
    return [token] if token in tree_files else []


def staged_sources(tree_files, text):
    """Every source a check script copies into its staging tree (`cp <src...> "$out/source/..."`)."""
    out = []
    for line in text.replace('\\\n', ' ').splitlines():
        found = re.match(r'\s*cp\s+(.+)$', line)
        if not found:
            continue
        try:
            tokens = shlex.split(found.group(1))
        except ValueError:
            continue
        tokens = [t for t in tokens if not t.startswith('-')]
        if len(tokens) < 2 or '/source/' not in tokens[-1]:
            continue
        for token in tokens[:-1]:
            if '$' in token:
                continue
            out.extend(expand(tree_files, token))
    return out


def compile_units(tree_files, text):
    """Every `swiftc ... <files>.swift` compile unit a check script builds."""
    units = []
    for line in text.replace('\\\n', ' ').splitlines():
        if 'swiftc' not in line:
            continue
        try:
            tokens = shlex.split(line)
        except ValueError:
            continue
        unit = []
        for token in tokens:
            if token.endswith('.swift') and '$' not in token:
                unit.extend(expand(tree_files, token))
        if unit:
            units.append(unit)
    return units


# Real module specifiers only: a `'../host/index.js'` string passed to spawn is not an import.
IMPORT = re.compile(r"""(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"](\.[^'"]+)['"]"""
                    r"""|^\s*import\s*['"](\.[^'"]+)['"]""", re.MULTILINE)


def ts_imports(text):
    for found in IMPORT.finditer(text):
        yield found.group(1) or found.group(2)


def resolve_import(source, spec, tree_files):
    base = os.path.normpath(os.path.join(os.path.dirname(source), spec))
    stem = base[:-3] if base.endswith('.js') else base
    for candidate in (stem + '.ts', stem + '.tsx', stem + '/index.ts'):
        if candidate in tree_files:
            return candidate
    return None


# Only top-level types, and only in code: a comment that says "Item 3" or a nested `enum Mode`
# is not a cross-file reference, and locals named `check` or `escape` never were.
SWIFT_DECL = re.compile(r'^(?:(?:final|public|internal|private|fileprivate|@\w+)\s+)*'
                        r'(?:class|struct|enum|actor|protocol|typealias)\s+([A-Z]\w{3,})', re.MULTILINE)


def swift_code(text):
    return re.sub(r'//[^\n]*', ' ', re.sub(r'/\*.*?\*/', ' ', text, flags=re.DOTALL))


def swift_declarations(text):
    return set(SWIFT_DECL.findall(swift_code(text)))


def static_pass(head_tree, changed):
    problems = []
    declaration_owners = {}

    def owner_index():
        if declaration_owners:
            return declaration_owners
        for path in head_tree.files:
            if not path.endswith('.swift') or not (path.startswith('Sources/') or path.startswith('Tests/')):
                continue
            for name in swift_declarations(head_tree.read(path) or ''):
                declaration_owners.setdefault(name, set()).add(path)
        return declaration_owners

    def owners(name):
        return owner_index().get(name, set())
    changed = set(changed)
    scripts = [f for f in head_tree.files if re.match(r'scripts/check-[^/]+\.sh$', f)]
    for script in scripts:
        text = head_tree.read(script) or ''
        staged = staged_sources(head_tree.files, text)
        staged_set = set(staged)
        for holder in staged:
            body = head_tree.read(holder)
            if body is None:
                continue
            for spec in ts_imports(body):
                target = resolve_import(holder, spec, head_tree.files)
                if target and target in changed and target not in staged_set:
                    problems.append(f'{script} stages {holder}, which imports {target}, but the staging list does not name {target}')
                    staged_set.add(target)
        swift_changed = sorted(f for f in changed if f.endswith('.swift'))
        if not swift_changed:
            continue
        for unit in compile_units(head_tree.files, text):
            compiled = swift_code('\n'.join(head_tree.read(f) or '' for f in unit))
            for candidate in swift_changed:
                if candidate in unit:
                    continue
                # A name only this changed file declares: anything else would be a false positive
                # from the same type being declared twice.
                declared = {n for n in swift_declarations(head_tree.read(candidate) or '')
                            if owners(n) == {candidate}}
                used = sorted(n for n in declared
                              if re.search(r'\b%s\b' % re.escape(n), compiled) is not None)
                if used:
                    problems.append(f'{script} compiles a unit that uses {used[0]} from {candidate}, but the unit does not name {candidate}')
    for problem in problems:
        print(f'STATIC FAIL: {problem}')
    if problems:
        return 1
    print(f'STATIC PASS: {len(changed)} changed file(s), every staged import and Swift unit is closed')
    return 0


PLIST_TOP = {'Label', 'ProgramArguments', 'RunAtLoad', 'StartCalendarInterval'}
PLIST_CAL = {'Minute', 'Hour', 'Day', 'Weekday', 'Month'}


def validate_plist(raw):
    try:
        doc = plistlib.loads(raw)
    except Exception as error:  # noqa: BLE001 - any parse failure is the finding
        return [f'not a property list: {error}']
    if not isinstance(doc, dict):
        return ['the root is not a dictionary']
    problems = [f'{key} is not a key launchd reads here' for key in doc if key not in PLIST_TOP]
    problems += [f'{key} is missing, so the agent would not run' for key in
                 ('Label', 'ProgramArguments', 'StartCalendarInterval') if key not in doc]
    interval = doc.get('StartCalendarInterval')
    entries = interval if isinstance(interval, list) else [interval]
    for entry in entries:
        if not isinstance(entry, dict):
            problems.append('StartCalendarInterval is not a dictionary or a list of dictionaries')
            continue
        problems += [f'StartCalendarInterval.{key} is not a key launchd reads '
                     f'(Minute, Hour, Day, Weekday, Month only)' for key in entry if key not in PLIST_CAL]
    return problems


def lint(path):
    result = subprocess.run(['plutil', '-lint', path], capture_output=True, text=True)
    return result.returncode == 0


def plist_pass(base, head):
    head_tree = Tree(sha=head)
    changed = changed_files(base, head)
    if not any(path.startswith('Sources/') for path in changed):
        print('PLIST SKIP: no Sources/ change in this range')
        return 0
    writers = [f for f in head_tree.files
               if f.startswith('Sources/') and f.endswith('.swift')
               and 'StartCalendarInterval' in (head_tree.read(f) or '')]
    if not writers:
        print('PLIST SKIP: no Sources/ writer emits StartCalendarInterval at this head')
        return 0
    if shutil.which('swiftc') is None:
        print('PLIST SKIP: swiftc is not installed here, so the writer cannot be rendered')
        return 0
    writer = writers[0]
    text = head_tree.read(writer) or ''
    code = swift_code(text)
    plist_func = re.search(r'static\s+func\s+plist\s*\(', code)
    # The type that opens nearest above the writer function owns it: a file can hold several types.
    owner = None
    if plist_func:
        for found in SWIFT_DECL.finditer(code):
            if found.start() < plist_func.start():
                owner = found.group(1)
    if owner is None:
        print(f'PLIST SKIP: {writer} does not expose a static plist(startMs:...) writer to render')
        return 0
    work = tempfile.mkdtemp(prefix='didi-plist-')
    try:
        rendered = os.path.join(work, 'main.swift')
        with open(rendered, 'w', encoding='utf-8') as handle:
            handle.write('import Foundation\n'
                         f'print({owner}.plist(startMs: 1_800_000_000_000, '
                         'label: "com.lux.didi.alarm.synthetic", appPath: "/Applications/LuxDidi.app"))\n')
        binary = os.path.join(work, 'render')
        source = os.path.join(work, os.path.basename(writer))
        with open(source, 'w', encoding='utf-8') as handle:
            handle.write(text)
        build = subprocess.run(['swiftc', '-O', source, rendered, '-o', binary],
                               capture_output=True, text=True, timeout=300)
        if build.returncode != 0:
            print('PLIST SKIP: the writer did not compile standalone: '
                  + (build.stderr.strip().splitlines() or ['no compiler output'])[0])
            return 0
        emit = subprocess.run([binary], capture_output=True, text=True, timeout=60)
        if emit.returncode != 0:
            print(f'PLIST FAIL: rendering {writer} failed: {emit.stderr.strip()[:200]}')
            return 1
        candidate = os.path.join(work, 'rendered.plist')
        with open(candidate, 'w', encoding='utf-8') as handle:
            handle.write(emit.stdout)
        problems = validate_plist(emit.stdout.encode())
        if not lint(candidate):
            problems.append('plutil -lint refuses the rendered plist')
        for problem in problems:
            print(f'PLIST FAIL: {problem}')
        if problems:
            return 1
        print(f'PLIST PASS: {writer} renders a plist with the whitelisted keys only')
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def map_mode():
    base, head = args[0], args[1]
    changed = changed_files(base, head)
    checks = checks_for(changed)
    for path in changed:
        if re.match(r'scripts/check-[^/]+\.sh$', path) and path not in checks:
            checks.append(path)
    if not checks:
        if not changed:
            print('COMBINED nothing changed in this range')
            return 0
        print('COMBINED FAILED: no check covers the changed files; extend config/check-map.json', file=sys.stderr)
        return 1
    print('\n'.join(checks))
    return 0


def static_mode():
    base, head = args[0], args[1]
    return static_pass(Tree(sha=head), changed_files(base, head))


def selftest():
    failures = []

    def expect(condition, label):
        if not condition:
            failures.append(label)
            print(f'SELFTEST FAIL: {label}')

    entries = check_map()
    declared = {check for entry in entries for check in entry['checks']}
    tree = Tree(path=root, dirs=['server', 'Sources', 'Tests', 'web', 'docs', 'config', 'scripts'])
    for path in tree.files:
        expect(bool(checks_for([path])), f'config/check-map.json has no entry for {path}')
    for script in sorted(f for f in tree.files if re.match(r'scripts/check-[^/]+\.sh$', f)):
        expect(script in declared, f'{script} is not named by any config/check-map.json entry')
    print(f'SELFTEST map: {len(tree.files)} path(s), {len([f for f in tree.files if re.match(r"scripts/check-", f)])} check script(s)')

    # The import-graph pass: a staging list that misses a module its target imports must fail, and
    # adding the file must make it pass. This is the check-prompt staging break, synthetic.
    fixture = tempfile.mkdtemp(prefix='didi-static-')
    try:
        os.makedirs(os.path.join(fixture, 'scripts'))
        os.makedirs(os.path.join(fixture, 'server'))
        with open(os.path.join(fixture, 'server/a.ts'), 'w', encoding='utf-8') as handle:
            handle.write("import { b } from './b.js';\nexport const a = b;\n")
        with open(os.path.join(fixture, 'server/b.ts'), 'w', encoding='utf-8') as handle:
            handle.write('export const b = 1;\n')
        script = os.path.join(fixture, 'scripts/check-fixture.sh')
        with open(script, 'w', encoding='utf-8') as handle:
            handle.write('cp server/a.ts "$out/source/"\n')
        fixture_tree = Tree(path=fixture)
        expect(static_pass(fixture_tree, ['server/b.ts']) == 1,
               'the staging pass accepted a list missing server/b.ts')
        with open(script, 'a', encoding='utf-8') as handle:
            handle.write('cp server/b.ts "$out/source/"\n')
        fixture_tree = Tree(path=fixture)
        expect(static_pass(fixture_tree, ['server/b.ts']) == 0,
               'the staging pass refused a complete list')
        # And the Swift unit half: a unit that uses a type from a changed file it does not compile.
        os.makedirs(os.path.join(fixture, 'Sources/LuxDidi'))
        os.makedirs(os.path.join(fixture, 'Tests/DidiLiveTests'))
        with open(os.path.join(fixture, 'Sources/LuxDidi/NewJournal.swift'), 'w', encoding='utf-8') as handle:
            handle.write('final class NewJournal { static let shared = NewJournal() }\n')
        with open(os.path.join(fixture, 'Tests/DidiLiveTests/Unit.swift'), 'w', encoding='utf-8') as handle:
            handle.write('let journal = NewJournal.shared\n')
        with open(script, 'a', encoding='utf-8') as handle:
            handle.write('swiftc -o "$work/unit" Tests/DidiLiveTests/Unit.swift\n')
        fixture_tree = Tree(path=fixture)
        expect(static_pass(fixture_tree, ['Sources/LuxDidi/NewJournal.swift']) == 1,
               'the Swift pass accepted a unit missing a referenced file')
        with open(script, 'w', encoding='utf-8') as handle:
            handle.write('cp server/a.ts "$out/source/"\ncp server/b.ts "$out/source/"\n'
                         'swiftc -o "$work/unit" Sources/LuxDidi/NewJournal.swift Tests/DidiLiveTests/Unit.swift\n')
        fixture_tree = Tree(path=fixture)
        expect(static_pass(fixture_tree, ['Sources/LuxDidi/NewJournal.swift']) == 0,
               'the Swift pass refused a complete unit')
    finally:
        shutil.rmtree(fixture, ignore_errors=True)

    # The plist validator: a valid agent passes, a Year key (which launchd ignores) fails.
    work = tempfile.mkdtemp(prefix='didi-plist-')
    try:
        valid = os.path.join(work, 'valid.plist')
        with open(valid, 'wb') as handle:
            plistlib.dump({'Label': 'com.lux.didi.alarm.synthetic', 'RunAtLoad': True,
                           'ProgramArguments': ['/Applications/LuxDidi.app/Contents/MacOS/LuxDidi', '--alarm'],
                           'StartCalendarInterval': {'Minute': 5, 'Hour': 9, 'Day': 1, 'Weekday': 2, 'Month': 3}},
                          handle)
        expect(validate_plist(open(valid, 'rb').read()) == [] and lint(valid),
               'the plist validator refused a valid agent')
        year = os.path.join(work, 'year.plist')
        with open(year, 'wb') as handle:
            plistlib.dump({'Label': 'com.lux.didi.alarm.synthetic', 'RunAtLoad': True,
                           'ProgramArguments': ['/Applications/LuxDidi.app/Contents/MacOS/LuxDidi', '--alarm'],
                           'StartCalendarInterval': {'Year': 2027, 'Month': 3, 'Day': 1, 'Hour': 9, 'Minute': 5}},
                          handle)
        expect(any('Year' in problem for problem in validate_plist(open(year, 'rb').read())),
               'the plist validator accepted a Year key launchd ignores')
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if failures:
        print(f'SELFTEST FAILED: {len(failures)} fixture(s)')
        return 1
    print('SELFTEST PASSED')
    return 0


if mode == 'map':
    raise SystemExit(map_mode())
if mode == 'static':
    raise SystemExit(static_mode())
if mode == 'plist':
    raise SystemExit(plist_pass(args[0], args[1]))
if mode == 'selftest':
    raise SystemExit(selftest())
raise SystemExit(f'COMBINED FAILED: unknown analysis mode {mode!r}')
PY
}

run_checks() {
  local base="$1" head="$2" checks="$3" static_log="$4"
  local logdir summary table failed=0 check start rc seconds last last_file
  logdir="$(mktemp -d "${TMPDIR:-/tmp}/didi-combined.XXXXXX")"
  summary="${DIDI_CHECK_SUMMARY:-$logdir/summary.md}"
  table=''
  for check in $checks; do
    start=$(date +%s)
    rc=0
    last_file="$logdir/$(printf '%s' "$check" | tr '/.' '__').log"
    bash "$root/$check" >"$last_file" 2>&1 || rc=$?
    seconds=$(( $(date +%s) - start ))
    last="$(grep -aoE 'not ok [0-9]+ - .*|✖ .*|^FAIL [^ ].*' "$last_file" | tail -1 | cut -c1-120)"
    [[ -z "$last" ]] && last='-'
    [[ $rc -ne 0 ]] && failed=$((failed + 1))
    table+="| \`$check\` | $rc | ${seconds}s | $last |"$'\n'
    printf 'COMBINED %s rc=%s %ss\n' "$check" "$rc" "$seconds"
  done
  {
    printf '# Combined-tree gate: %s..%s\n\n' "$base" "$head"
    printf '## Static passes\n\n```\n'
    cat "$static_log"
    printf '```\n\n## Checks\n\n'
    if [[ -n "$table" ]]; then
      printf '| check | rc | duration | last failing test |\n| --- | --- | --- | --- |\n'
      printf '%s' "$table"
    else
      printf 'No check ran.\n'
    fi
    if [[ $failed -eq 0 ]]; then printf '\nEvery check passed.\n'; else printf '\n%s check(s) failed.\n' "$failed"; fi
  } >"$summary"
  [[ "$summary" != /dev/stdout ]] && cat "$summary"
  printf 'COMBINED summary %s\n' "$summary"
  rm -rf "$logdir"
  [[ $failed -eq 0 ]]
}

case "${1:-}" in
  --selftest) analysis selftest; exit $? ;;
  -h|--help|'')
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

base="$1" head="${2:-}"
if [[ -z "$head" ]]; then
  echo 'COMBINED FAILED: usage: scripts/check-combined-tree.sh <base> <head> [--static]' >&2
  exit 2
fi
static_only=0
[[ "${3:-}" == '--static' ]] && static_only=1

echo "COMBINED gate $base..$head"
checks="$(analysis map "$base" "$head")"
printf 'COMBINED checks: %s\n' "$(printf '%s' "$checks" | tr '\n' ' ')"
logdir="$(mktemp -d "${TMPDIR:-/tmp}/didi-combined-static.XXXXXX")"
trap 'rm -rf "$logdir"' EXIT
static_log="$logdir/static.log"
status=0
analysis static "$base" "$head" 2>&1 | tee "$static_log" || status=1
analysis plist "$base" "$head" 2>&1 | tee -a "$static_log" || status=1

if [[ $static_only -eq 0 ]]; then
  run_checks "$base" "$head" "$checks" "$static_log" || status=1
else
  summary="${DIDI_CHECK_SUMMARY:-$logdir/summary.md}"
  { printf '# Combined-tree gate: %s..%s\n\n## Static passes\n\n```\n' "$base" "$head"
    cat "$static_log"; printf '```\n\nNo check ran (--static).\n'; } >"$summary"
  printf 'COMBINED summary %s\n' "$summary"
fi

if [[ $status -eq 0 ]]; then
  echo "COMBINED PASSED $base..$head"
else
  echo "COMBINED FAILED $base..$head" >&2
fi
exit "$status"
