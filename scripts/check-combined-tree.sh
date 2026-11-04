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


def wholesale_sources(tree_files, text):
    """Every source a check stages by copying whole directories (`find <root> ... -exec cp [-R] {} "$out/source/" \\;`).

    Such a check cannot miss a source its targets import, but the literal extractor below cannot see
    the copy at all; without this the closure pass would report every import of the whole copied tree
    as a missing staging entry. The exclusions on the find line (`! -name node_modules` and friends)
    are honoured, so a directory the check deliberately leaves out stays out.
    """
    out = []
    for line in text.replace('\\\n', ' ').splitlines():
        found = re.search(r'find\s+(\S+)\s+[^|;]*-exec\s+cp\s+(?:-R\s+)?\{\}\s+"?\$out/source/"?', line)
        if not found:
            continue
        root = found.group(1).rstrip('/')
        excluded = {name.strip('"\'') for name in re.findall(r'!\s+-name\s+(\S+)', line)}
        for path in tree_files:
            if not path.startswith(root + '/'):
                continue
            parts = path[len(root) + 1:].split('/')
            if any(part in excluded for part in parts[:-1]):
                continue
            if len(parts) == 1 and parts[0] in excluded:
                continue
            out.append(path)
    return out


def staged_sources(tree_files, text):
    """Every source a check script copies into its staging tree (`cp <src...> "$out/source/..."`)."""
    out = wholesale_sources(tree_files, text)
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
    warnings = []
    for script in scripts:
        text = head_tree.read(script) or ''
        staged = staged_sources(head_tree.files, text)
        staged_set = set(staged)
        # F4: the extractors read literal text. Say so when a check builds or stages in a shape they
        # cannot see, so a green pass is never mistaken for full coverage.
        if re.search(r'\bswift build\b', text):
            warnings.append(f'{script} builds with swift build; its compile units are not extracted')
        elif 'swiftc' in text and not compile_units(head_tree.files, text):
            warnings.append(f'{script} runs swiftc without a literal <file>.swift list; its units are not extracted')
        if '/source/' in text and not staged:
            warnings.append(f'{script} stages into $out/source but no literal cp source was extracted')
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
    for warning in dict.fromkeys(warnings):
        print(f'STATIC WARN: {warning}')
    for problem in dict.fromkeys(problems):
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


def lint(path, executable=shutil.which('plutil')):
    if executable:
        result = subprocess.run([executable, '-lint', path], capture_output=True, text=True)
        return result.returncode == 0
    # Linux CI has no plutil. Parse the bytes rather than skipping syntax validation.
    try:
        with open(path, 'rb') as handle:
            plistlib.load(handle)
        return True
    except Exception:  # Malformed or unreadable boundary input is not a valid plist.
        return False


def render_writer(tree):
    """Render the app's own plist writer at a fixed synthetic time, then validate what it emitted.

    A writer that exists at this head and cannot be rendered is a FAILURE, never a pass: the commit
    that introduces a bad key is exactly where an unrenderable writer would hide it. SKIP is kept only
    for a range with no writer, or a host without swiftc."""
    writers = [f for f in tree.files if f.startswith('Sources/') and f.endswith('.swift')
               and 'StartCalendarInterval' in (tree.read(f) or '')]
    if not writers:
        return 'SKIP', 'no Sources/ writer emits StartCalendarInterval at this head'
    if shutil.which('swiftc') is None:
        return 'SKIP', 'swiftc is not installed here, so the writer cannot be rendered'
    writer = writers[0]
    text = tree.read(writer) or ''
    code = swift_code(text)
    plist_func = re.search(r'static\s+func\s+plist\s*\(', code)
    # The type that opens nearest above the writer function owns it: a file can hold several types.
    owner = None
    if plist_func:
        for found in SWIFT_DECL.finditer(code):
            if found.start() < plist_func.start():
                owner = found.group(1)
    if owner is None:
        return 'FAIL', f'{writer} emits StartCalendarInterval but no static plist(startMs:...) to render'
    work = tempfile.mkdtemp(prefix='didi-plist-')
    try:
        source = os.path.join(work, os.path.basename(writer))
        with open(source, 'w', encoding='utf-8') as handle:
            handle.write(text)
        # The app calls this writer on the main actor; a plain main.swift is a synchronous nonisolated
        # context and cannot, so the harness is a @MainActor entry point.
        harness = os.path.join(work, 'Render.swift')
        with open(harness, 'w', encoding='utf-8') as handle:
            handle.write('import Foundation\n\n'
                         '@main\n@MainActor\nstruct Render {\n'
                         '    static func main() {\n'
                         f'        print({owner}.plist(startMs: 1_800_000_000_000, '
                         'label: "com.lux.didi.alarm.synthetic", appPath: "/Applications/LuxDidi.app"))\n'
                         '    }\n}\n')
        binary = os.path.join(work, 'render')
        build = subprocess.run(['swiftc', '-O', source, harness, '-o', binary],
                               capture_output=True, text=True, timeout=300)
        if build.returncode != 0:
            first = (build.stderr.strip().splitlines() or ['no compiler output'])[0]
            return 'FAIL', f'{writer} exists at this head but does not render: {first}'
        emit = subprocess.run([binary], capture_output=True, text=True, timeout=60)
        if emit.returncode != 0:
            return 'FAIL', f'rendering {writer} failed: {emit.stderr.strip()[:200]}'
        candidate = os.path.join(work, 'rendered.plist')
        with open(candidate, 'w', encoding='utf-8') as handle:
            handle.write(emit.stdout)
        problems = validate_plist(emit.stdout.encode())
        if not lint(candidate):
            problems.append('plutil -lint refuses the rendered plist')
        if problems:
            return 'FAIL', f'{writer}: ' + '; '.join(problems)
        return 'PASS', f'{writer} renders a plist with the whitelisted keys only'
    finally:
        shutil.rmtree(work, ignore_errors=True)


def plist_pass(base, head):
    if not any(path.startswith('Sources/') for path in changed_files(base, head)):
        print('PLIST SKIP: no Sources/ change in this range')
        return 0
    verdict, detail = render_writer(Tree(sha=head))
    print(f'PLIST {verdict}: {detail}')
    return 1 if verdict == 'FAIL' else 0


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
        expect(lint(valid, executable=None), 'portable parser refused a valid plist')
        malformed = os.path.join(work, 'malformed.plist')
        with open(malformed, 'wb') as handle:
            handle.write(b'not a property list')
        expect(not lint(malformed, executable=None), 'portable parser accepted malformed bytes')
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

# The summary records the machine's load average at the start and end of the run, so a slow check
# on the shared Mac can be told from a regression (docs/checks.md, "Timing").
load_average() {
  if [[ -r /proc/loadavg ]]; then
    cut -d' ' -f1-3 /proc/loadavg
  elif command -v sysctl >/dev/null 2>&1; then
    sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1" "$2" "$3}'
  else
    uptime
  fi
}

run_checks() {
  local base="$1" head="$2" checks="$3" static_log="$4"
  local logdir summary table failed=0 blocked=0 total=0 selected=0 check start rc seconds verdict last last_file load_start load_end
  logdir="$(mktemp -d "${TMPDIR:-/tmp}/didi-combined.XXXXXX")"
  summary="${DIDI_CHECK_SUMMARY:-${TMPDIR:-/tmp}/didi-combined-summary.md}"
  timing="${DIDI_TIMING_FILE:-}"
  table=''
  load_start="$(load_average)"
  for check in $checks; do
    selected=$((selected + 1))
    start=$(date +%s)
    rc=0
    last_file="$logdir/$(printf '%s' "$check" | tr '/.' '__').log"
    bash "${checks_root:-$root}/$check" >"$last_file" 2>&1 || rc=$?
    seconds=$(( $(date +%s) - start ))
    last="$(grep -aoE 'not ok [0-9]+ - .*|✖ .*|^FAIL [^ ].*' "$last_file" | tail -1 | cut -c1-120)"
    [[ -z "$last" ]] && last='-'
    verdict=pass
    if [[ $rc -ne 0 ]]; then
      # A check that cannot run says so and is never read as a pass: a blocked check is counted
      # apart from a failed one, and both keep the release from shipping.
      if grep -q 'CHECK BLOCKED' "$last_file"; then
        verdict=blocked
        blocked=$((blocked + 1))
        printf 'COMBINED blocked: %s (exit %s)\n' "$check" "$rc"
      else
        verdict=failed
        failed=$((failed + 1))
        printf 'COMBINED failure output: %s\n' "$check"
        grep -aE 'not ok [0-9]+|✖ |error:|error TS|FAIL ' "$last_file" | tail -n 40 || true
        tail -n 60 "$last_file"
      fi
    fi
    total=$((total + seconds))
    if [[ -n "$timing" ]]; then printf 'COMBINED_CHECK\t%s\t%s\t%s\n' "$check" "$verdict" "$seconds" >> "$timing"; fi
    table+="| \`$check\` | $verdict | ${seconds}s | $last |"$'\n'
    printf 'COMBINED %s %s %ss\n' "$check" "$verdict" "$seconds"
  done
  load_end="$(load_average)"
  {
    printf '# Combined-tree gate: %s..%s\n\n' "$base" "$head"
    printf '<!-- COMBINED head=%s base=%s selected=%s pass=%s fail=%s blocked=%s total=%ss load-start="%s" load-end="%s" -->\n\n' \
      "$head" "$base" "$selected" "$((selected - failed - blocked))" "$failed" "$blocked" "$total" "$load_start" "$load_end"
    printf '## Static passes\n\n```\n'
    cat "$static_log"
    printf '```\n\n## Checks\n\n'
    if [[ -n "$table" ]]; then
      printf '| check | result | duration | last failing test |\n| --- | --- | --- | --- |\n'
      printf '%s' "$table"
      printf '| counts | %s pass, %s failed, %s blocked | | |\n' "$((selected - failed - blocked))" "$failed" "$blocked"
      printf '| total | | %ss | |\n' "$total"
      printf '\nSelected %s check(s); load average at start `%s`, at end `%s`.\n' "$selected" "$load_start" "$load_end"
    else
      printf 'No check ran.\n'
    fi
    if [[ -n "$timing" ]]; then
      {
        printf 'COMBINED_HEAD\thead\t%s\n' "$head"
        printf 'COMBINED_BASE\tbase\t%s\n' "$base"
        printf 'COMBINED_SELECTED\tcount\t%s\n' "$selected"
        printf 'COMBINED_SELECTED\tnames\t%s\n' "$(printf '%s ' $checks)"
        printf 'COMBINED_COUNTS\tpass\t%s\n' "$((selected - failed - blocked))"
        printf 'COMBINED_COUNTS\tfail\t%s\n' "$failed"
        printf 'COMBINED_COUNTS\tblocked\t%s\n' "$blocked"
        printf 'COMBINED_TOTAL\tall\t%s\n' "$total"
        printf 'COMBINED_LOAD\tstart\t%s\n' "$load_start"
        printf 'COMBINED_LOAD\tend\t%s\n' "$load_end"
      } >> "$timing"
    fi
    if [[ $failed -eq 0 && $blocked -eq 0 ]]; then
      printf '\nEvery check passed, in %ss.\n' "$total"
    elif [[ $blocked -ne 0 ]]; then
      printf '\n%s check(s) failed and %s could not run, in %ss.\n' "$failed" "$blocked" "$total"
    else
      printf '\n%s check(s) failed, in %ss.\n' "$failed" "$total"
    fi
  } >"$summary"
  [[ "$summary" != /dev/stdout ]] && cat "$summary"
  printf 'COMBINED summary %s\n' "$summary"
  rm -rf "$logdir"
  [[ $failed -eq 0 && $blocked -eq 0 ]]
}

# The blocked/failed split is what keeps a check that cannot run from reading as a pass, so it is
# proved on three fixture checks rather than trusted: one passes, one fails, one prints CHECK
# BLOCKED. The blocked one must be counted apart from the failed one and must still fail the gate.
selftest_checks() {
  local fixture status summary timing
  fixture="$(mktemp -d "${TMPDIR:-/tmp}/didi-combined-selftest.XXXXXX")"
  printf '#!/bin/bash\necho PASSING\n' > "$fixture/pass.sh"
  printf '#!/bin/bash\necho "not ok 1 - fixture failure"\nexit 1\n' > "$fixture/fail.sh"
  printf '#!/bin/bash\necho "FIXTURE CHECK BLOCKED: no runtime" >&2\nexit 2\n' > "$fixture/blocked.sh"
  summary="$fixture/summary.md"
  timing="$fixture/timing.tsv"
  status=0
  checks_root="$fixture"
  DIDI_CHECK_SUMMARY="$summary" DIDI_TIMING_FILE="$timing" \
    run_checks fixture fixture "pass.sh fail.sh blocked.sh" "$fixture/static.log" \
    > "$fixture/out.log" 2>&1 || status=$?
  if [[ $status -eq 0 ]]; then
    echo 'COMBINED SELFTEST FAIL: a blocked and a failed check still passed the gate' >&2
    rm -rf "$fixture"; return 1
  fi
  grep -q '| `.*fail.sh` | failed |' "$summary" \
    || { echo 'COMBINED SELFTEST FAIL: a failed check was not reported as failed' >&2; rm -rf "$fixture"; return 1; }
  grep -q '| `.*blocked.sh` | blocked |' "$summary" \
    || { echo 'COMBINED SELFTEST FAIL: a blocked check was not counted apart from a failed one' >&2; rm -rf "$fixture"; return 1; }
  grep -q '| `.*pass.sh` | pass |' "$summary" \
    || { echo 'COMBINED SELFTEST FAIL: a passing check was not reported as a pass' >&2; rm -rf "$fixture"; return 1; }
  grep -Eq '^\| total \| \| [0-9]+s \| \|$' "$summary" \
    || { echo 'COMBINED SELFTEST FAIL: the summary has no total duration row' >&2; rm -rf "$fixture"; return 1; }
  grep -q $'^COMBINED_TOTAL\tall\t[0-9]*$' "$timing" \
    || { echo 'COMBINED SELFTEST FAIL: no machine readable total was recorded' >&2; rm -rf "$fixture"; return 1; }
  grep -q $'^COMBINED_CHECK\t.*blocked.sh\tblocked\t[0-9]*$' "$timing" \
    || { echo 'COMBINED SELFTEST FAIL: the blocked check was not recorded' >&2; rm -rf "$fixture"; return 1; }
  # The timing record carries the head, the base, the selected checks, the three counts, the total
  # and the machine's load average at both ends, so a slow check can be told from a loaded host.
  for field in $'COMBINED_HEAD\thead\t.*' $'COMBINED_BASE\tbase\t.*' $'COMBINED_SELECTED\tcount\t3' \
    $'COMBINED_SELECTED\tnames\t.*pass.sh .*fail.sh .*blocked.sh *' $'COMBINED_COUNTS\tpass\t1' \
    $'COMBINED_COUNTS\tfail\t1' $'COMBINED_COUNTS\tblocked\t1' $'COMBINED_TOTAL\tall\t[0-9]*' \
    $'COMBINED_LOAD\tstart\t..*' $'COMBINED_LOAD\tend\t..*'; do
    grep -q "^$field\$" "$timing" \
      || { echo "COMBINED SELFTEST FAIL: the timing record is missing $field" >&2; rm -rf "$fixture"; return 1; }
  done
  grep -q '^<!-- COMBINED head=fixture base=fixture selected=3 pass=1 fail=1 blocked=1 total=[0-9]*s load-start=' "$summary" \
    || { echo 'COMBINED SELFTEST FAIL: the summary does not name its head, base, counts and load' >&2; rm -rf "$fixture"; return 1; }
  echo 'COMBINED SELFTEST PASS: pass, failed and blocked are counted apart, and the record names head, base, counts and load'
  rm -rf "$fixture"
}

case "${1:-}" in
  --selftest) analysis selftest || exit $?; selftest_checks || exit $?; exit 0 ;;
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
  summary="${DIDI_CHECK_SUMMARY:-${TMPDIR:-/tmp}/didi-combined-summary.md}"
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
