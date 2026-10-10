#!/usr/bin/env python3
"""Lux Didi planning integrity validator.

Validates the public planning package of the Lux Didi repository: the assembled
backlog in ``planning/backlog.json``, the README and ``docs/*.md``, and the
repository shape. It is a planning helper, not an application test.

Usage:
    python3 scripts/backlog_validate.py --all --report planning/backlog-validation.md

Options:
    --all                 run every check (required)
    --report PATH         Markdown report path (default planning/backlog-validation.md)
    --json PATH           machine-readable report path (default: same stem, .json)
    --packets DIR         validate five per-lane ``issues.json`` packets in DIR instead
                          of the assembled backlog (offline source-packet mode)
    --root PATH           repository root (default: parent of this script)

The validator is read-only except for the two report files it writes. It makes
no network requests, so link reachability is reported as not checked rather than
as verified. Output is deterministic for a fixed revision so that re-running on
the same commit produces byte-identical reports.

Check ids follow the reviewer's validator contract (V-01 to V-14) plus the
integration checks (X-01 to X-08) defined for the assembled backlog.

Definitions used by the checks:
    V-08 word band: tasks are expected in the 300 to 650 word target band; the
        band is reported with outliers named, a task under 250 words fails as
        too thin, and a task over 900 words fails as padding. V-08 also checks
        that each task body contains the required section concepts. That is a
        presence and size check only: it is not proof of content quality, and
        the independent reviewer reads every section substantively (R-V08-WEAK).
    V-14 negative-control self-test: the plan size is never asserted from a
        literal count, so the coverage checks are derived from the assembled
        node set. V-14 proves those derived checks still bite by running them
        against deliberately broken copies of the loaded nodes (duplicate id,
        numbering gap, wrong master prefix, epic child mismatch, dependency
        cycle, dash code point, private shape, missing baseline, header total
        drift, stale body hash) and reporting a failure unless the broken copy
        is rejected and the unmutated copy is accepted.
    V-09 near-duplicate measure: token 4-gram Jaccard similarity over body
        tokens; pairs at or above 0.30 are reported, pairs at or above 0.75 fail
        as copied boilerplate.
    V-10 dash check: Unicode code points U+2013 and U+2014 fail; U+2015 and
        U+2212 are reported; a positive control proves the detector works.
    V-11 privacy scan is meaning-first: known private shapes (absolute home
        paths, secret shapes, real address domains, private record identifiers)
        fail; benign public documentation shapes are allowed (loopback OAuth
        examples, RFC and IANA paths, ``example.invalid`` and ``example.com``
        addresses, and public integration package names).
    V-12 link policy: every URL is https (loopback http examples are allowed);
        a body with no URL is reported unless it states a non-public baseline
        or names a public source. Unlinked public sources are warnings, not
        failures.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCHEMA = "lux-didi.backlog/1"
VERIFIER_ROOT = Path(__file__).resolve().parent.parent

MILESTONES = {
    "M0": "Proof and contracts",
    "M1": "Useful daily loop",
    "M2": "Voice and proactive beta",
    "M3": "Controlled execution and integrations",
    "M4": "Portability and polish",
}

# master -> id prefix. This is the namespace contract, not a size. The number of
# epics, the number of tasks per master and the id ranges are derived from the
# assembled node set below, so growing the plan never edits a count in this file.
MASTER_PREFIX = {"A": "A", "B": "B", "C": "C", "D": "D", "E": "F"}

PROGRAM_ID = "P00"
EPIC_ID_RE = re.compile(r"^E\d{2}$")


def epic_ids(nodes: list[dict]) -> list[str]:
    return sorted(n.get("id") for n in nodes or [] if n.get("kind") == "epic")


def task_ids_for_master(nodes: list[dict], master: str) -> list[str]:
    return [n.get("id") for n in nodes or []
            if n.get("kind") == "task" and n.get("master") == master]


def expected_ids(nodes: list[dict]) -> set[str]:
    """The complete id set implied by the node set: P00, one contiguous E## run and
    one contiguous prefix+## run per master, each derived from the observed counts."""
    ids = {PROGRAM_ID}
    ids |= {f"E{i:02d}" for i in range(1, len(epic_ids(nodes)) + 1)}
    for master, prefix in MASTER_PREFIX.items():
        count = len(task_ids_for_master(nodes, master))
        ids |= {f"{prefix}{i:02d}" for i in range(1, count + 1)}
    return ids

DOCS = [
    "architecture.md",
    "roadmap.md",
    "parallel-masters.md",
    "research.md",
    "privacy-and-authority.md",
    "acceptance.md",
    "decisions.md",
    "risks.md",
    "overnight-execution.md",
    "cloud-deployment.md",
    "client-service-contract.md",
]

REQUIRED_KEYS = [
    "id",
    "title",
    "kind",
    "master",
    "epic",
    "phase",
    "priority",
    "depends_on",
    "body",
]

PHASES = list(MILESTONES)
PRIORITIES = ["P0", "P1", "P2"]
KINDS = ["program", "epic", "task"]

ID_TOKEN = re.compile(r"\bP00\b|\b[A-F]\d{2}\b")

DASH_FAIL = {"\u2013": "U+2013 EN DASH", "\u2014": "U+2014 EM DASH"}
DASH_WARN = {"\u2015": "U+2015 HORIZONTAL BAR", "\u2212": "U+2212 MINUS SIGN"}

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
MENTION_RE = re.compile(r"(?<![A-Za-z0-9._%+-])@[A-Za-z][A-Za-z0-9_-]{1,}")
URL_RE = re.compile(r"https?://[^\s)\]<>\"'`]+")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")

SECRET_RES = [
    (re.compile(r"sk-[A-Za-z0-9_-]{16,}"), "api key shape"),
    (re.compile(r"ghp_[A-Za-z0-9]{20,}"), "github token shape"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "github token shape"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "aws key shape"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY"), "private key block"),
    (re.compile(r"(?i)(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{8,}"), "credential assignment"),
]

PRIVATE_SHAPES = [
    (re.compile(r"/Users/"), "absolute home path"),
    (re.compile(r"~/"), "home-relative path"),
    (re.compile(r"C:\\Users"), "windows home path"),
    (re.compile(r"\.local\b"), "private host suffix"),
    (re.compile(r"\.internal\b"), "private host suffix"),
    (re.compile(r"\blux[_ -]record\b", re.I), "record id reference"),
    (re.compile(r"\bsession-[0-9a-f]{8,}\b"), "session id shape"),
    (re.compile(r"\brun[_-][0-9a-f]{8,}\b"), "run id shape"),
    (re.compile(r"\b[0-9a-f]{32,}\b"), "long hex identifier"),
]

ALLOWED_EMAIL_DOMAINS = ("example.invalid", "example.com")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]")

NONPUBLIC_RE = re.compile(
    r"(?i)(non-public|not public|no public link|no link|no links|unpublished|"
    r"private baseline|internal baseline|not published|cannot be linked)"
)
PUBLIC_SOURCE_RE = re.compile(
    r"(?i)(public (references|documentation|docs|source|specification)|"
    r"official documentation|vendor documentation|open-source|open source|"
    r"model context protocol|developer\.(google|apple)\.com|ai\.google\.dev|"
    r"docs\.openclaw\.ai|specification revision)"
)

PLACEHOLDER_RE = re.compile(r"(?i)\b(TODO|TBD|FIXME|XXX|lorem ipsum)\b")

SECTION_PATTERNS = [
    ("outcome", re.compile(r"(?i)(user outcome|trigger and outcome|problem and outcome|trigger and problem|outcome)")),
    ("scope", re.compile(r"(?i)(scope|deliverables|proposed work)")),
    ("out_of_scope", re.compile(r"(?i)(out of scope|not in scope|not this task)")),
    ("interfaces", re.compile(r"(?i)(interfaces?[^.\n]{0,40}(ownership|reuse)|ownership and reuse|interface and ownership|interfaces and reuse)")),
    ("dependencies", re.compile(r"(?i)(dependenc|depends on)")),
    ("acceptance", re.compile(r"(?i)(acceptance|adverse|scenario)")),
    ("validation", re.compile(r"(?i)(validation|future test|test scenario|verify|measured)")),
    ("evidence", re.compile(r"(?i)evidence")),
]

WORD_BAND = (300, 650)
WORD_FLOOR = 250
WORD_CEILING = 900

NEAR_DUP_REPORT = 0.30
NEAR_DUP_FAIL = 0.75

ALLOWED_PATHS = {
    "README.md",
    "README",
    "scripts/backlog_validate.py",
    "scripts/backlog_render.py",
    "planning/backlog.json",
    "planning/backlog-validation.md",
    "planning/backlog-validation.json",
    "planning/issue-map.json",
    "planning/publishing-validation.md",
    "docs/domain-contract.md",
    "docs/mcp-adapter.md",
    "docs/model-adapter.md",
    "docs/prompt-composition.md",
    "docs/web-client.md",
    "docs/implementation-status.md",
    "docs/live-voice-adapter.md",
    "docs/local-development.md",
    "docs/lux-knowledge-connector.md",
    "docs/native-request-recovery.md",
    "docs/live-gateway.md",
    "docs/live-session-core.md",
    "docs/native-conversation-protocol.md",
    "docs/selected-memory-context.md",
    "docs/selected-memory-interface.md",
    "docs/native-live-client.md",
    "fixtures/domain/library-basic.json",
    "scripts/check-domain.sh",
    "scripts/check-mcp.sh",
    "scripts/check-model.sh",
    "scripts/check-prompt.sh",
    "scripts/check-host-entry.sh",
    "scripts/check-knowledge-connector.sh",
    "scripts/check-live-voice.sh",
    "scripts/check-pending-request.sh",
    "scripts/check-live-gateway.sh",
    "scripts/check-live-session.sh",
    "scripts/check-memory-context.sh",
    "scripts/check-native-conversation.sh",
    "scripts/check-selected-memory-ui.sh",
    "scripts/check-archive-scale.sh",
    "scripts/check-native-live.sh",
}
ALLOWED_PATHS |= {f"docs/{name}" for name in DOCS}

# Product paths of explicitly assigned, imminent units. Each is admitted by exact literal,
# never a wildcard. A unit that has not landed contributes no file: an absent path is never
# fabricated and never blocks the paths that are present.
PRODUCT_PATHS = (
    "docs/conversation-runtime.md",
    "docs/service-packaging.md",
    "scripts/check-chat.sh",
    "scripts/check-package.sh",
    "docs/local-runtime.md",
    "scripts/check-host.sh",
    "scripts/run-local.sh",
    "docs/local-install.md",
    "scripts/package-local.mjs",
    "scripts/install-local.mjs",
    "scripts/check-install.sh",
    "docs/companion-protocol.md",
    "docs/connected-chat.md",
    "scripts/check-connected.sh",
    "docs/provider-configuration.md",
    "scripts/check-provider-config.sh",
)
PRODUCT_DOCS = tuple(rel for rel in PRODUCT_PATHS if rel.startswith("docs/"))
ALLOWED_PATHS |= set(PRODUCT_PATHS)

# The repository is code-bearing: accepted components publish their own source trees.
# These are declared roots and named files, never an open wildcard.
COMPONENT_ROOTS = ("server/", "Sources/", "Tests/", "Resources/", "web/")
COMPONENT_FILES = (
    "scripts/check-service.sh",
    "docs/service-runtime.md",
    "docs/mac-experience.md",
)

# Paths that must never be published, whatever else the tree contains. Applied first to
# the tracked public set, then to the pruned tree scan; findings are deduplicated.
FORBIDDEN_PATH_RES = (
    (re.compile(r"(^|/)\.env($|\.)"), "environment file"),
    (re.compile(r"(^|/)(credentials?|secrets?)(\.|$)", re.I), "credential file"),
    (re.compile(r"\.(pem|key|p12|pfx|jks|keystore)$", re.I), "key material"),
    (re.compile(r"(^|/)id_(rsa|dsa|ecdsa|ed25519)($|\.)"), "private key"),
    (re.compile(r"(^|/)\.ssh/"), "ssh material"),
    (re.compile(r"(^|/)\.github/workflows/"), "workflow file"),
)

# Directories excluded from publication-set validation because they are build or
# dependency artifacts, not public source. They are pruned, never whitelisted.
PRUNED_DIRS = {".git", "node_modules", "dist", "build", ".next", "target", "out",
               "__pycache__", ".venv", "venv"}


def is_forbidden_path(rel: str) -> str | None:
    for pattern, label in FORBIDDEN_PATH_RES:
        if pattern.search(rel):
            return label
    return None


def is_publication_path(rel: str) -> bool:
    if rel in ALLOWED_PATHS or rel in COMPONENT_FILES:
        return True
    return any(rel.startswith(prefix) for prefix in COMPONENT_ROOTS)


def missing_required_documents(walked: set[str]) -> list[str]:
    """Required documents absent from the tracked public set. DOCS is the mandatory corpus;
    an optional product document is never required, so an unlanded unit cannot fail here."""
    return [f"docs/{name}" for name in DOCS if f"docs/{name}" not in walked]


def forbidden_findings(tracked: list[str], scanned: list[str]) -> list[tuple[str, str]]:
    """Forbidden paths, reported from the tracked public set first and then from the pruned
    tree scan, deduplicated so a path seen twice is reported once and never suppressed.

    The tracked pass matters because the scan prunes artifact directories regardless of
    whether a path inside them is tracked, so a tracked key file under a pruned directory
    would otherwise be invisible to both passes. The scan still runs, so a real credential
    file that is ignored but present on disk is reported too.
    """
    found: dict[str, str] = {}
    for rel in list(tracked) + list(scanned):
        label = is_forbidden_path(rel)
        if label and rel not in found:
            found[rel] = label
    return sorted(found.items())


def tracked_public_files(root: Path, exclude: set[str]) -> list[str] | None:
    """Tracked files plus untracked-but-not-ignored files: what could be published.
    Gitignored build artifacts are excluded here, exactly as the ruling requires."""
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard"],
        capture_output=True, text=True, check=False, env=_git_env())
    if out.returncode != 0:
        return None
    return sorted({line.strip() for line in out.stdout.splitlines() if line.strip()} - exclude)


def read_docs_text(root: Path) -> dict[str, str]:
    """Load the explicit document corpus shared by the content checks.

    The corpus is README.md, the required DOCS documents, the admitted product documents and the
    publication report. Each listed product document enters the same content and privacy checks
    when it is present; a path that does not exist is skipped, never fabricated.
    """
    texts = {}
    for rel in ["README.md", *(f"docs/{name}" for name in DOCS), *PRODUCT_DOCS,
                "planning/publishing-validation.md"]:
        path = root / rel
        if path.exists():
            texts[rel] = path.read_text(encoding="utf-8")
    return texts


def _git_env() -> dict:
    """A hermetic git environment: no system or user configuration is read."""
    env = dict(os.environ)
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def v13_tracked_boundary_fixture() -> tuple[bool, bool, str]:
    """Run the real public-path enumeration against a disposable temporary git repo.

    The fixture force-tracks an inert key-class filename under a pruned build directory and
    keeps a genuinely gitignored non-key artifact beside it, then calls the same
    tracked_public_files, scanned_paths and forbidden_findings functions check_v13 uses. It
    therefore tests the enumeration boundary rather than a helper list. The directory is
    removed afterwards; nothing outside it is read or written, there is no credential and no
    network call.
    """
    tmp = Path(tempfile.mkdtemp(prefix="lux-didi-v13-fixture-"))
    try:
        (tmp / "server" / "dist").mkdir(parents=True)
        (tmp / "server" / ".gitignore").write_text("dist/\nnode_modules/\n", encoding="utf-8")
        (tmp / "server" / "dist" / "id_ed25519").write_text(
            "inert fixture text, not a key\n", encoding="utf-8")
        (tmp / "server" / "dist" / "bundle.js").write_text(
            "// ignored build artifact\n", encoding="utf-8")
        env = _git_env()
        for args in (["init", "-q"], ["add", "-f", "server/dist/id_ed25519"]):
            run = subprocess.run(["git", "-C", str(tmp)] + args, capture_output=True,
                                 text=True, env=env)
            if run.returncode != 0:
                return False, False, f"fixture git {args[0]} failed"
        tracked = tracked_public_files(tmp, set()) or []
        scanned = scanned_paths(tmp)
        findings = forbidden_findings(tracked, scanned)
        hits = [item for item in findings if item[0] == "server/dist/id_ed25519"]
        rejected_once = len(hits) == 1 and hits[0][1] == "private key"
        ignored_allowed = not any("bundle.js" in rel for rel, _label in findings)
        detail = (f"tracked={len(tracked)} scan={len(scanned)} findings={len(findings)} "
                  f"rejected_once={rejected_once} ignored_build_allowed={ignored_allowed}")
        return rejected_once, ignored_allowed, detail
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def scanned_paths(root: Path) -> list[str]:
    """Every file outside the pruned artifact directories, for the forbidden-path scan."""
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in PRUNED_DIRS]
        for name in filenames:
            found.append((Path(dirpath) / name).relative_to(root).as_posix())
    return sorted(found)


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def add(self, check_id: str, title: str, failures: list[str], warnings: list[str] | None = None, details=None) -> None:
        warnings = warnings or []
        status = "FAIL" if failures else ("WARN" if warnings else "PASS")
        self.checks.append(
            {
                "id": check_id,
                "title": title,
                "status": status,
                "failures": failures,
                "warnings": warnings,
                "details": details if details is not None else {},
            }
        )

    @property
    def failed(self) -> bool:
        return any(c["status"] == "FAIL" for c in self.checks)


def words(text: str) -> int:
    return len(text.split())


def canonical_nodes(nodes: list[dict]) -> str:
    payload = json.dumps(nodes, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def tracked_files(root: Path) -> list[str] | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    files = [line for line in out.stdout.splitlines() if line.strip()]
    return sorted(files) if files else None


def tree_digest(root: Path, exclude: set[str]) -> tuple[str, list[str]]:
    entries = []
    tracked = tracked_files(root)
    if tracked is not None:
        candidates = tracked
    else:
        candidates = []
        for path in sorted(root.rglob("*")):
            rel = path.relative_to(root).as_posix()
            if path.is_dir():
                continue
            if rel.startswith(".git/") or rel == ".git":
                continue
            candidates.append(rel)
    for rel in candidates:
        if rel in exclude:
            continue
        path = root / rel
        if not path.is_file():
            continue
        entries.append(f"{rel}\0{hashlib.sha256(path.read_bytes()).hexdigest()}")
    digest = hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()
    return digest, [entry.split("\0")[0] for entry in entries]


def git_head(root: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except OSError:
        pass
    return "unknown"


def load_backlog(root: Path, packets_dir: Path | None) -> tuple[dict | None, dict | None, list[str]]:
    errors: list[str] = []
    if packets_dir is not None:
        nodes: list[dict] = []
        generated: dict[str, str] = {}
        for lane in ["tooling", "knowledge", "connectors", "commitments", "naya"]:
            path = packets_dir / lane / "issues.json"
            if not path.exists():
                errors.append(f"missing packet {path}")
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                errors.append(f"{lane}: JSON parse error: {exc}")
                continue
            if not isinstance(data, list):
                errors.append(f"{lane}: packet is not an array")
                continue
            generated[lane] = hashlib.sha256(path.read_bytes()).hexdigest()
            nodes.extend(data)
        milestones = [{"id": mid, "title": title} for mid, title in MILESTONES.items()]
        return {"schema": SCHEMA, "generated_from": generated, "milestones": milestones, "nodes": nodes}, nodes, errors

    path = root / "planning" / "backlog.json"
    if not path.exists():
        return None, None, [f"missing {path.relative_to(root)}"]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return None, None, [f"planning/backlog.json: JSON parse error: {exc}"]
    if not isinstance(data, dict):
        return None, None, ["planning/backlog.json: top level is not an object"]
    return data, data.get("nodes") if isinstance(data.get("nodes"), list) else None, errors


def check_v01(report: Report, backlog: dict | None, nodes: list[dict] | None, parse_errors: list[str]) -> None:
    failures = list(parse_errors)
    details = {}
    if backlog is None:
        report.add("V-01", "Backlog parses and covers the expected totals", failures)
        return
    allowed_top = {"schema", "planning_date", "generated_from", "corrections", "node_hashes", "milestones", "nodes"}
    unknown_top = sorted(set(backlog) - allowed_top)
    if unknown_top:
        failures.append(f"unknown top-level keys: {unknown_top}")
    if backlog.get("schema") != SCHEMA:
        failures.append(f"schema is {backlog.get('schema')!r}, expected {SCHEMA!r}")
    if not isinstance(nodes, list):
        failures.append("nodes is missing or not an array")
        report.add("V-01", "Backlog parses and covers the expected totals", failures)
        return
    ids = [n.get("id") for n in nodes if isinstance(n, dict)]
    kinds = [n.get("kind") for n in nodes if isinstance(n, dict)]
    details["total"] = len(nodes)
    details["program"] = kinds.count("program")
    details["epics"] = kinds.count("epic")
    details["tasks"] = kinds.count("task")
    unknown_kinds = sorted({k for k in kinds if k not in KINDS})
    if unknown_kinds:
        failures.append(f"unknown kinds: {unknown_kinds}")
    if len(nodes) != kinds.count("program") + kinds.count("epic") + kinds.count("task"):
        failures.append(f"total {len(nodes)} does not match the program, epic and task counts")
    if kinds.count("program") != 1:
        failures.append(f"expected exactly one program tracker, found {kinds.count('program')}")
    if kinds.count("epic") < 1:
        failures.append("expected at least one epic")
    if kinds.count("task") < 1:
        failures.append("expected at least one task")
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        failures.append(f"duplicate ids: {duplicates}")
    tracker = next((n for n in nodes if n.get("id") == PROGRAM_ID), None)
    if tracker is None:
        failures.append(f"{PROGRAM_ID} program tracker is missing")
    else:
        tracker_body = tracker.get("body") or ""
        stated_epics = re.findall(r"(\d+)\s+epics\b", tracker_body)
        stated_tasks = re.findall(r"(\d+)\s+work items\b", tracker_body)
        if not stated_epics or not stated_tasks:
            failures.append(f"{PROGRAM_ID} body must state its epic and work-item totals")
        else:
            if int(stated_epics[0]) != kinds.count("epic"):
                failures.append(f"{PROGRAM_ID} states {stated_epics[0]} epics, backlog has {kinds.count('epic')}")
            if int(stated_tasks[0]) != kinds.count("task"):
                failures.append(f"{PROGRAM_ID} states {stated_tasks[0]} work items, backlog has {kinds.count('task')}")
    report.add("V-01", "Backlog parses and covers the expected totals", failures, details=details)


def check_v02(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    if nodes:
        for node in nodes:
            if not isinstance(node, dict):
                failures.append("node is not an object")
                continue
            keys = set(node)
            missing = [k for k in REQUIRED_KEYS if k not in keys]
            unknown = sorted(keys - set(REQUIRED_KEYS))
            node_id = node.get("id", "<no id>")
            if missing:
                failures.append(f"{node_id}: missing keys {missing}")
            if unknown:
                failures.append(f"{node_id}: unknown keys {unknown}")
    report.add("V-02", "Every node has exactly the required keys", failures)


def check_v03(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    for node in nodes or []:
        node_id = node.get("id", "<no id>")
        kind = node.get("kind")
        master = node.get("master")
        if kind not in KINDS:
            failures.append(f"{node_id}: kind {kind!r} not in {KINDS}")
        if node_id == "P00":
            if kind != "program":
                failures.append(f"{node_id}: kind must be program")
            if master is not None:
                failures.append(f"{node_id}: master must be null")
        elif kind == "epic":
            if master not in MASTER_PREFIX:
                failures.append(f"{node_id}: master {master!r} not in A..E")
            expected_prefix = master
            if expected_prefix and not node_id.startswith("E"):
                failures.append(f"{node_id}: epic id should be E##")
        elif kind == "task":
            if master not in MASTER_PREFIX:
                failures.append(f"{node_id}: master {master!r} not in A..E")
            else:
                prefix = MASTER_PREFIX[master]
                if not re.fullmatch(prefix + r"\d{2}", node_id):
                    failures.append(f"{node_id}: id prefix does not match master {master}")
        if node.get("phase") not in PHASES:
            failures.append(f"{node_id}: phase {node.get('phase')!r} not in {PHASES}")
        if node.get("priority") not in PRIORITIES:
            failures.append(f"{node_id}: priority {node.get('priority')!r} not in {PRIORITIES}")
    report.add("V-03", "Enums and master namespace consistency", failures)


def check_v04(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    ids = [n.get("id") for n in (nodes or [])]
    expected = expected_ids(nodes or [])
    present = {i for i in ids if isinstance(i, str)}
    missing = sorted(expected - present)
    extra = sorted(present - expected)
    if missing:
        failures.append(f"missing ids: {missing}")
    if extra:
        failures.append(f"unexpected ids: {extra}")
    for node in nodes or []:
        node_id = node.get("id")
        kind = node.get("kind")
        text = node_id if isinstance(node_id, str) else ""
        if kind == "program":
            if text != PROGRAM_ID:
                failures.append(f"{text!r}: the program tracker id must be {PROGRAM_ID}")
        elif kind == "epic":
            if not EPIC_ID_RE.fullmatch(text):
                failures.append(f"{text!r}: an epic id must match E##")
        elif kind == "task":
            master = node.get("master")
            prefix = MASTER_PREFIX.get(master)
            if prefix is None:
                failures.append(f"{text!r}: task master {master!r} has no id prefix")
            elif not re.fullmatch(prefix + r"\d{2}", text):
                failures.append(f"{text!r}: a master {master} task id must match {prefix}##")
    report.add("V-04", "Id format and complete coverage", failures, details={"count": len(ids), "expected": len(expected)})


def check_v05(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    by_id = {n.get("id"): n for n in nodes or []}
    epics = {n.get("id"): n for n in nodes or [] if n.get("kind") == "epic"}
    children: dict[str, list[str]] = {e: [] for e in epics}
    attached = 0
    for node in nodes or []:
        node_id = node.get("id")
        kind = node.get("kind")
        epic = node.get("epic")
        if kind == "task":
            if epic not in epics:
                failures.append(f"{node_id}: epic {epic!r} is not a declared epic id")
                continue
            children[epic].append(node_id)
            attached += 1
            expected_master = epics[epic].get("master")
            if node.get("master") != expected_master:
                failures.append(f"{node_id}: master {node.get('master')!r} does not match epic {epic} (master {expected_master!r})")
        else:
            if epic is not None:
                failures.append(f"{node_id}: epic must be null for kind {kind}")
    task_count = sum(1 for n in nodes or [] if n.get("kind") == "task")
    if attached != task_count:
        failures.append(f"{task_count - attached} task(s) are not attached to a declared epic")
    for epic in sorted(children):
        kids = sorted(children[epic])
        if not kids:
            failures.append(f"{epic}: epic has no child tasks")
        body = (by_id.get(epic) or {}).get("body", "")
        for kid in kids:
            if not re.search(r"(?<![A-Z0-9])" + re.escape(kid) + r"(?![0-9])", body):
                failures.append(f"{epic}: child {kid} is not referenced in the epic body")
    report.add("V-05", "Epic membership and parent/child references", failures)


def check_v06(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    by_id = {n.get("id"): n for n in nodes or []}
    edges = 0
    adj: dict[str, list[str]] = {}
    for node in nodes or []:
        node_id = node.get("id")
        deps = node.get("depends_on")
        if not isinstance(deps, list):
            failures.append(f"{node_id}: depends_on is not an array")
            continue
        if len(set(deps)) != len(deps):
            failures.append(f"{node_id}: duplicate dependency entries")
        if node_id == "P00" and deps:
            failures.append("P00: program tracker must not depend on leaves")
        adj[node_id] = []
        for dep in deps:
            if dep == node_id:
                failures.append(f"{node_id}: self dependency")
            if dep not in by_id:
                failures.append(f"{node_id}: dependency {dep} does not resolve")
                continue
            if by_id[dep].get("kind") != "task":
                failures.append(f"{node_id}: dependency {dep} is not a task")
                continue
            adj[node_id].append(dep)
            edges += 1
    state: dict[str, int] = {}
    stack: list[str] = []
    cycles: list[str] = []

    def visit(node_id: str) -> None:
        state[node_id] = 1
        stack.append(node_id)
        for nxt in adj.get(node_id, []):
            if state.get(nxt) == 1:
                cycles.append(" -> ".join(stack[stack.index(nxt):] + [nxt]))
            elif state.get(nxt, 0) == 0:
                visit(nxt)
        stack.pop()
        state[node_id] = 2

    for node_id in sorted(adj):
        if state.get(node_id, 0) == 0:
            visit(node_id)
    if cycles:
        failures.append(f"cycle(s): {cycles}")
    report.add("V-06", "Graph resolution and acyclicity", failures, details={"edges": edges})


def check_v07(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    warnings: list[str] = []
    order = {phase: i for i, phase in enumerate(PHASES)}
    by_id = {n.get("id"): n for n in nodes or []}
    phase_counts = {p: 0 for p in PHASES}
    for node in nodes or []:
        phase = node.get("phase")
        if phase in phase_counts:
            phase_counts[phase] += 1
    for node in nodes or []:
        node_id = node.get("id")
        node_phase = node.get("phase")
        for dep in node.get("depends_on") or []:
            dep_node = by_id.get(dep)
            if not dep_node:
                continue
            if order.get(dep_node.get("phase"), 0) > order.get(node_phase, 0):
                failures.append(f"{node_id} ({node_phase}) depends on {dep} ({dep_node.get('phase')}) in a later phase")
    if phase_counts.get("M4", 0) == 0:
        warnings.append("M4 has no nodes")
    for phase, count in phase_counts.items():
        if count == 0:
            warnings.append(f"{phase} has no nodes")
    report.add("V-07", "Phase presence and dependency phase order", failures, warnings, details=phase_counts)


def check_v08(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    warnings: list[str] = []
    word_stats = {"min": None, "max": None, "values": {}}
    for node in nodes or []:
        node_id = node.get("id")
        kind = node.get("kind")
        body = node.get("body") or ""
        count = words(body)
        if kind == "task":
            word_stats["values"][node_id] = count
        if kind == "task":
            if count < WORD_FLOOR:
                failures.append(f"{node_id}: only {count} words, below the {WORD_FLOOR} word floor")
            elif count > WORD_CEILING:
                failures.append(f"{node_id}: {count} words, above the {WORD_CEILING} word ceiling")
            elif count < WORD_BAND[0] or count > WORD_BAND[1]:
                warnings.append(f"{node_id}: {count} words, outside the {WORD_BAND[0]} to {WORD_BAND[1]} target band")
            if not node.get("title", "").startswith(f"[{node_id}]"):
                failures.append(f"{node_id}: title does not start with [{node_id}]")
            for name, pattern in SECTION_PATTERNS:
                if not pattern.search(body):
                    failures.append(f"{node_id}: missing section concept {name}")
        elif kind == "epic":
            if not body.strip():
                failures.append(f"{node_id}: empty epic body")
        elif kind == "program":
            if not body.strip():
                failures.append(f"{node_id}: empty program body")
            for phase in PHASES:
                if phase not in body:
                    failures.append(f"{node_id}: program body does not name {phase}")
            for master in MASTER_PREFIX:
                if not re.search(rf"\b{master}\b", body):
                    failures.append(f"{node_id}: program body does not name lane {master}")
    values = list(word_stats["values"].values())
    if values:
        word_stats["min"] = min(values)
        word_stats["max"] = max(values)
        word_stats["median"] = sorted(values)[len(values) // 2]
    report.add("V-08", "Required section concepts and body size", failures, warnings, details=word_stats)


def _shingles(text: str, n: int = 4) -> set[tuple[str, ...]]:
    toks = re.findall(r"[a-z0-9]+", text.lower())
    return {tuple(toks[i : i + n]) for i in range(max(0, len(toks) - n + 1))}


def check_v09(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    warnings: list[str] = []
    tasks = [(n.get("id"), n.get("body") or "") for n in nodes or [] if n.get("kind") == "task"]
    shingles = {node_id: _shingles(body) for node_id, body in tasks}
    ids = sorted(shingles)
    pairs = []
    for i, left in enumerate(ids):
        for right in ids[i + 1 :]:
            a, b = shingles[left], shingles[right]
            if not a or not b:
                continue
            score = len(a & b) / len(a | b)
            if score >= NEAR_DUP_FAIL:
                failures.append(f"{left} and {right}: 4-gram Jaccard {score:.2f} at or above {NEAR_DUP_FAIL}")
            elif score >= NEAR_DUP_REPORT:
                warnings.append(f"{left} and {right}: 4-gram Jaccard {score:.2f}")
                pairs.append((round(score, 3), left, right))
    pairs.sort(reverse=True)
    report.add(
        "V-09",
        "Near-duplicate task bodies",
        failures,
        warnings,
        details={"reported_pairs": pairs[:20], "threshold_report": NEAR_DUP_REPORT, "threshold_fail": NEAR_DUP_FAIL},
    )


def scan_dashes(text: str) -> tuple[list[str], list[str]]:
    hard = [name for ch, name in DASH_FAIL.items() if ch in text]
    soft = [name for ch, name in DASH_WARN.items() if ch in text]
    return hard, soft


def check_v10(report: Report, nodes: list[dict] | None, docs_text: dict[str, str]) -> None:
    failures: list[str] = []
    warnings: list[str] = []
    for node in nodes or []:
        hard, soft = scan_dashes(node.get("body") or "")
        if hard:
            failures.append(f"{node.get('id')}: {hard}")
        if soft:
            warnings.append(f"{node.get('id')}: {soft}")
    for name, text in docs_text.items():
        hard, soft = scan_dashes(text)
        if hard:
            failures.append(f"{name}: {hard}")
        if soft:
            warnings.append(f"{name}: {soft}")
    control_text = "dash control \u2014 present"
    hard, _ = scan_dashes(control_text)
    control_ok = "U+2014 EM DASH" in hard
    if not control_ok:
        failures.append("positive control failed: the em dash detector did not fire")
    report.add("V-10", "Dash code points with positive control", failures, warnings, details={"positive_control": control_ok})


def check_v11(report: Report, nodes: list[dict] | None, docs_text: dict[str, str]) -> None:
    failures: list[str] = []
    warnings: list[str] = []
    texts = [("README.md", docs_text.get("README.md", ""))]
    texts += [(name, text) for name, text in docs_text.items() if name != "README.md"]
    texts += [(f"{n.get('id')}", n.get("body") or "") for n in nodes or []]
    for name, text in texts:
        for pattern, label in SECRET_RES:
            if pattern.search(text):
                failures.append(f"{name}: {label}")
        for pattern, label in PRIVATE_SHAPES:
            if pattern.search(text):
                failures.append(f"{name}: {label}")
        for match in EMAIL_RE.finditer(text):
            domain = match.group(0).rsplit("@", 1)[1].lower()
            if not domain.endswith(ALLOWED_EMAIL_DOMAINS):
                failures.append(f"{name}: address domain {domain!r} is not synthetic")
        for match in MENTION_RE.finditer(text):
            failures.append(f"{name}: mention shape {match.group(0)!r}")
        for match in URL_RE.finditer(text):
            url = match.group(0)
            if url.startswith("http://"):
                host = url[len("http://") :].split("/", 1)[0].split(":", 1)[0]
                if host not in LOOPBACK_HOSTS:
                    failures.append(f"{name}: non-https URL {url[:60]}")
            host = url.split("://", 1)[1].split("/", 1)[0].split(":", 1)[0]
            if host.endswith((".local", ".internal", ".lan", ".corp")):
                failures.append(f"{name}: private host {host}")
            elif host and host not in LOOPBACK_HOSTS:
                if host.startswith("github.com") and "PEAT-AI/lux-didi" not in url:
                    warnings.append(f"{name}: review external repository link {url[:70]}")
        if PLACEHOLDER_RE.search(text):
            placeholder = PLACEHOLDER_RE.search(text).group(0)
            failures.append(f"{name}: placeholder text {placeholder!r}")
    report.add("V-11", "Privacy, secret and personal-data shapes", failures, warnings)


def check_v12(report: Report, nodes: list[dict] | None, docs_text: dict[str, str]) -> None:
    failures: list[str] = []
    warnings: list[str] = []
    for node in nodes or []:
        node_id = node.get("id")
        body = node.get("body") or ""
        if URL_RE.search(body):
            continue
        if NONPUBLIC_RE.search(body):
            continue
        if PUBLIC_SOURCE_RE.search(body):
            warnings.append(f"{node_id}: public source named without a link")
        else:
            failures.append(f"{node_id}: no URL and no non-public baseline statement")
    for name, text in docs_text.items():
        for match in URL_RE.finditer(text):
            url = match.group(0)
            if url.startswith("http://"):
                host = url[len("http://") :].split("/", 1)[0].split(":", 1)[0]
                if host not in LOOPBACK_HOSTS:
                    failures.append(f"{name}: non-https URL {url[:60]}")
    report.add(
        "V-12",
        "Link policy and baseline statements",
        failures,
        warnings,
        details={"reachability": "not checked (no network access in the validator)"},
    )


def check_v13(report: Report, root: Path, exclude: set[str]) -> None:
    failures: list[str] = []
    warnings: list[str] = []
    walked = tracked_public_files(root, exclude)
    if walked is None:
        report.add("V-13", "Repository hygiene and intended public set",
                   ["git could not list the tracked public source"])
        return

    # Publication-set membership: the intended tracked public source only. A forbidden
    # path is reported by the forbidden pass below, which runs on this same tracked set
    # before any pruning, so nothing is suppressed here.
    for rel in walked:
        if is_forbidden_path(rel):
            continue
        if not is_publication_path(rel):
            failures.append(f"unexpected published path: {rel}")

    # Forbidden paths: the tracked public set first, then the whole tree with build and
    # dependency artifact directories pruned. Findings are deduplicated, never dropped.
    scanned = scanned_paths(root)
    findings = forbidden_findings(walked, scanned)
    for rel, label in findings:
        failures.append(f"forbidden path ({label}): {rel}")

    for rel in missing_required_documents(set(walked)):
        failures.append(f"missing document {rel}")
    for required in ["README.md", "scripts/backlog_validate.py", "scripts/backlog_render.py",
                     "planning/backlog.json", "planning/issue-map.json"]:
        if required not in walked:
            failures.append(f"missing {required}")
    if (root / ".github" / "workflows").exists():
        failures.append(".github/workflows exists")

    # Negative and positive controls. A repair that accepts every path, or rejects
    # every component path, must not pass.
    controls = {
        "forbidden_rejected": {
            "server/.env": "environment file",
            "Sources/secrets.json": "credential file",
            "planning/credentials.json": "credential file",
            "server/certs/tls.pem": "key material",
            ".github/workflows/ci.yml": "workflow file",
            "resources/id_ed25519": "private key",
            "server/dist/id_ed25519": "private key",
            "server/node_modules/pkg/cert.pfx": "key material",
        },
        "component_accepted": [
            "server/index.ts", "server/runtime/store.ts", "Sources/LuxDidi/LuxDidiApp.swift",
            "Tests/DidiMacTests/main.swift", "Resources/Info.plist", "web/src/app.ts",
            "docs/service-runtime.md", "docs/mac-experience.md", "scripts/check-service.sh",
            "planning/backlog.json", "README.md",
            "planning/publishing-validation.md",
            "docs/domain-contract.md", "docs/mcp-adapter.md", "docs/model-adapter.md",
            "docs/prompt-composition.md", "docs/web-client.md",
            "fixtures/domain/library-basic.json",
            "scripts/check-domain.sh", "scripts/check-mcp.sh", "scripts/check-model.sh",
            "scripts/check-prompt.sh",
        ],
        "unrelated_rejected": [
            "notes/scratch.md", "planning/private-notes.json", "tmp/x.txt",
            "planning/publishing-validation-extra.md", "docs/unrelated.md",
            "fixtures/domain/unrelated.json", "scripts/check-unrelated.sh",
        ],
        "product_accepted": list(PRODUCT_PATHS),
        "near_neighbor_rejected": [
            "docs/conversation-runtime-extra.md", "scripts/check-chat-extra.sh",
            "docs/service-packaging.md.bak", "docs/local-runtime-old.md",
            "scripts/run-local.sh.orig", "docs/connected-chat-old.md",
            "docs/provider-configuration-extra.md", "scripts/check-provider-config-extra.sh",
        ],
    }
    controls_ok = 0
    controls_total = len(controls["forbidden_rejected"]) + len(controls["component_accepted"]) \
        + len(controls["unrelated_rejected"]) + len(controls["product_accepted"]) \
        + len(controls["near_neighbor_rejected"]) + 3 + 2 + 2 + 4
    for rel, expected in controls["forbidden_rejected"].items():
        got = is_forbidden_path(rel)
        if got == expected:
            controls_ok += 1
        else:
            failures.append(f"control: {rel} should be forbidden as {expected!r}, got {got!r}")
    # A tracked forbidden path under a pruned directory must be reported by the tracked
    # pass, not only recognised by the predicate: this is the case the pruning hid.
    reported = dict(forbidden_findings(["server/dist/id_ed25519"], []))
    if reported.get("server/dist/id_ed25519") == "private key":
        controls_ok += 1
    else:
        failures.append("control: a tracked key file under a pruned directory was not reported")
    # A later scan sighting of the same path is deduplicated, not suppressed.
    both = forbidden_findings(["server/.env"], ["server/.env"])
    if both == [("server/.env", "environment file")]:
        controls_ok += 1
    else:
        failures.append(f"control: duplicate reporting was not deduplicated: {both}")
    # An ignored build artifact that is not a forbidden shape is left alone.
    if forbidden_findings([], ["server/dist/bundle.js", "server/node_modules/pkg/index.js"]) == []:
        controls_ok += 1
    else:
        failures.append("control: an ignored build artifact was reported as forbidden")
    # The real enumeration boundary, on a disposable temporary git fixture.
    rejected_once, ignored_allowed, fixture_detail = v13_tracked_boundary_fixture()
    if rejected_once:
        controls_ok += 1
    else:
        failures.append("fixture: a force-tracked key file under a pruned directory was not "
                        "rejected exactly once by the public-path enumeration")
    if ignored_allowed:
        controls_ok += 1
    else:
        failures.append("fixture: an actually gitignored non-key build artifact was reported")
    # Admission must not leave the publication report outside the privacy corpus.
    with tempfile.TemporaryDirectory(prefix="didi-publication-report-") as dirname:
        fixture_root = Path(dirname)
        report_rel = "planning/publishing-validation.md"
        fixture_report = fixture_root / report_rel
        fixture_report.parent.mkdir()
        fixture_report.write_text("Fixture: member@private.invalid\n", encoding="utf-8")
        leaking_probe = Report()
        check_v11(leaking_probe, None, read_docs_text(fixture_root))
        leaking_rejected = any(report_rel in failure and "address domain" in failure
                               for check in leaking_probe.checks for failure in check["failures"])
        fixture_report.write_text("Fixture: member@example.invalid\n", encoding="utf-8")
        clean_texts = read_docs_text(fixture_root)
        clean_probe = Report()
        check_v11(clean_probe, None, clean_texts)
        for passed, description in [
            (leaking_rejected, "leaking publication report was not rejected"),
            (report_rel in clean_texts and not clean_probe.failed,
             "clean publication report was not scanned and accepted"),
        ]:
            if passed:
                controls_ok += 1
            else:
                failures.append(f"control: {description}")
    # Actual-file control on the DEFAULT loader: the shared reader and V-11 together reject a
    # leaking product document and accept a clean one at a product document path, with no
    # test-only injection.
    with tempfile.TemporaryDirectory(prefix="didi-product-doc-") as dirname:
        fixture_root = Path(dirname)
        product_rel = PRODUCT_DOCS[0]
        fixture_doc = fixture_root / product_rel
        fixture_doc.parent.mkdir()
        fixture_doc.write_text("Fixture: member@private.invalid\n", encoding="utf-8")
        leaking_probe = Report()
        check_v11(leaking_probe, None, read_docs_text(fixture_root))
        leaking_rejected = any(product_rel in failure and "address domain" in failure
                               for check in leaking_probe.checks for failure in check["failures"])
        fixture_doc.write_text("Fixture: member@example.invalid\n", encoding="utf-8")
        clean_texts = read_docs_text(fixture_root)
        clean_probe = Report()
        check_v11(clean_probe, None, clean_texts)
        for passed, description in [
            (leaking_rejected, "leaking product document was not rejected"),
            (product_rel in clean_texts and not clean_probe.failed,
             "clean product document was not scanned and accepted"),
        ]:
            if passed:
                controls_ok += 1
            else:
                failures.append(f"control: {description}")
    # Discriminating production-loader control: every listed product document that is present
    # must be in the DEFAULT production corpus. It fails when production omits a present
    # product document and passes only when the production loader actually includes them.
    production_corpus = read_docs_text(root)
    present_product_docs = [rel for rel in PRODUCT_DOCS if (root / rel).exists()]
    omitted_product_docs = [rel for rel in present_product_docs if rel not in production_corpus]
    if present_product_docs and not omitted_product_docs:
        controls_ok += 1
    else:
        failures.append("control: production corpus omitted present product document(s): "
                        f"{omitted_product_docs or 'none present to scan'}")
    # Required documents stay mandatory and an absent future product document is harmless:
    # the required set is DOCS alone, and no product path is ever required.
    required = [f"docs/{name}" for name in DOCS]
    required_present = set(required)
    if (missing_required_documents(required_present) == []
            and missing_required_documents(required_present - {required[0]}) == [required[0]]
            and all(rel not in missing_required_documents(set()) for rel in PRODUCT_DOCS)):
        controls_ok += 1
    else:
        failures.append("control: required documents are not mandatory "
                        "or a product document is required")
    for rel in controls["component_accepted"]:
        if is_publication_path(rel) and not is_forbidden_path(rel):
            controls_ok += 1
        else:
            failures.append(f"control: accepted component path {rel} was not accepted")
    for rel in controls["unrelated_rejected"]:
        if not is_publication_path(rel):
            controls_ok += 1
        else:
            failures.append(f"control: unrelated path {rel} was accepted")
    for rel in controls["product_accepted"]:
        if is_publication_path(rel) and not is_forbidden_path(rel):
            controls_ok += 1
        else:
            failures.append(f"control: product path {rel} was not accepted")
    for rel in controls["near_neighbor_rejected"]:
        if not is_publication_path(rel):
            controls_ok += 1
        else:
            failures.append(f"control: near-neighbour path {rel} was accepted")
    if controls_ok != controls_total:
        failures.append(f"controls: {controls_ok} of {controls_total} behaved as required")
    if is_publication_path("anything/at/all.bin"):
        failures.append("control: the publication set accepts arbitrary paths")

    report.add("V-13", "Repository hygiene and intended public set", failures, warnings,
               details={"paths": len(walked), "controls": f"{controls_ok}/{controls_total}",
                        "forbidden": len(findings), "scanned": len(scanned),
                        "boundary_fixture": fixture_detail})


def check_x01(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    ids = {n.get("id") for n in nodes or []}
    refs = 0
    for node in nodes or []:
        node_id = node.get("id")
        for token in ID_TOKEN.findall(node.get("body") or ""):
            refs += 1
            if token not in ids:
                failures.append(f"{node_id}: body reference {token} does not resolve")
    report.add("X-01", "Body cross-references resolve to ids", failures, details={"references": refs})


def check_x02(report: Report, root: Path, docs_text: dict[str, str]) -> None:
    failures: list[str] = []
    readme = docs_text.get("README.md", "")
    for name in DOCS:
        target = f"docs/{name}"
        if target not in readme:
            failures.append(f"README.md does not link {target}")
    for name, text in docs_text.items():
        base = (root / name).parent
        for match in LINK_RE.finditer(text):
            target = match.group(1).strip()
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            target = target.split("#", 1)[0]
            if not target:
                continue
            candidate = (base / target).resolve()
            if not candidate.exists():
                failures.append(f"{name}: relative link does not resolve: {target}")
    report.add("X-02", "Documentation links resolve", failures)


def check_x03(report: Report, backlog: dict | None, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    milestones = (backlog or {}).get("milestones")
    if not isinstance(milestones, list):
        failures.append("milestones is missing or not an array")
    else:
        found = {}
        for item in milestones:
            if not isinstance(item, dict) or "id" not in item or "title" not in item:
                failures.append("milestone entries need id and title")
                continue
            found[item["id"]] = item["title"]
        for mid, title in MILESTONES.items():
            if found.get(mid) != title:
                failures.append(f"milestone {mid} should have title {title!r}, found {found.get(mid)!r}")
        extra = sorted(set(found) - set(MILESTONES))
        if extra:
            failures.append(f"unexpected milestones: {extra}")
    for node in nodes or []:
        if node.get("phase") not in MILESTONES:
            failures.append(f"{node.get('id')}: phase {node.get('phase')!r} has no milestone")
    report.add("X-03", "Milestone definitions match phases", failures)


def check_x04(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    p00 = next((n for n in nodes or [] if n.get("id") == "P00"), None)
    if p00 is None:
        failures.append("P00 tracker is missing")
    else:
        if p00.get("depends_on"):
            failures.append("P00 must not declare dependencies")
        body = p00.get("body") or ""
        if "program" not in (p00.get("title", "").lower()):
            failures.append("P00 title should name the program")
        if len(body.split()) < 150:
            failures.append("P00 body is too thin to carry the lane and milestone entry points")
    report.add("X-04", "Program tracker shape", failures)


def check_x05(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    for node in nodes or []:
        title = node.get("title") or ""
        body = node.get("body") or ""
        if len(title.split()) > 18:
            failures.append(f"{node.get('id')}: title longer than 18 words")
        if not body.strip():
            failures.append(f"{node.get('id')}: empty body")
    report.add("X-05", "Title and body presence", failures)


def check_x06(report: Report, backlog: dict | None, nodes: list[dict] | None, packets_mode: bool) -> None:
    details = {"assembly_digest": canonical_nodes(nodes or [])}
    failures: list[str] = []
    if not packets_mode and backlog is not None:
        generated = backlog.get("generated_from")
        if not isinstance(generated, dict) or sorted(generated) != ["commitments", "connectors", "knowledge", "naya", "tooling"]:
            failures.append("generated_from must name the five source lanes with digests")
    report.add("X-06", "Assembly digest", failures, details=details)


def check_x07(report: Report, backlog: dict | None, nodes: list[dict] | None, packets_mode: bool) -> None:
    failures: list[str] = []
    details = {}
    if packets_mode or backlog is None:
        report.add("X-07", "Snapshot body hashes, rendered hashes and correction record", [])
        return
    hashes = backlog.get("node_hashes")
    if not isinstance(hashes, dict):
        failures.append("node_hashes is missing or not an object")
    else:
        for node in nodes or []:
            node_id = node.get("id")
            expected = hashlib.sha256((node.get("body") or "").encode("utf-8")).hexdigest()
            if hashes.get(node_id) != expected:
                failures.append(f"{node_id}: node hash does not match the body")
        missing = sorted({n.get("id") for n in nodes or []} - set(hashes))
        if missing:
            failures.append(f"node_hashes misses ids: {missing}")
        details["hashed_nodes"] = len(hashes)
    corrections = backlog.get("corrections")
    if not isinstance(corrections, list) or not corrections:
        failures.append("corrections record is missing")
    else:
        joined = "\n".join(str(item) for item in corrections)
        for index in range(1, 11):
            if f"PUB-R2:{index}" not in joined:
                failures.append(f"corrections record does not name PUB-R2:{index}")
    renderer = VERIFIER_ROOT / "scripts" / "backlog_render.py"
    if not renderer.exists():
        failures.append("scripts/backlog_render.py is missing, so the render domain is unverified")
    else:
        run_env = dict(os.environ)
        run_env["PYTHONDONTWRITEBYTECODE"] = "1"
        run = subprocess.run([sys.executable, str(renderer), "--check", "--json"],
                             capture_output=True, text=True, env=run_env,
                             cwd=str(VERIFIER_ROOT))
        if run.returncode != 0:
            failures.append(f"renderer verification failed: {run.stdout.strip()[:200] or run.stderr.strip()[:200]}")
        else:
            try:
                rendered = json.loads(run.stdout.strip().splitlines()[-1])
            except (ValueError, IndexError):
                rendered = None
                failures.append("renderer verification did not print a JSON result")
            if rendered is not None:
                base = rendered.get("baseline") or {}
                current = rendered.get("current") or {}
                if not rendered.get("ok"):
                    failures.append("renderer verification reported not ok")
                if base.get("recorded", 0) < 101 or base.get("matched") != base.get("recorded"):
                    failures.append(f"renderer reproduced {base.get('matched')} of {base.get('recorded')} baseline rendered hashes")
                if current.get("mismatched"):
                    failures.append(f"renderer mismatched current nodes: {current['mismatched'][:5]}")
                if current.get("staged_number_collisions"):
                    failures.append(f"staged numbers collide with observed: {current['staged_number_collisions']}")
                if current.get("created_rendered", 0) < 1:
                    failures.append("renderer produced no rendered body for a created node")
                if current.get("numbering_failures"):
                    failures.append(f"renderer numbering failures: {current['numbering_failures'][:5]}")
                if not current.get("controls_ok"):
                    failures.append(f"renderer numbering controls did not hold: {current.get('controls')}")
                details["rendered_baseline"] = f"{base.get('matched')}/{base.get('recorded')}"
                details["numbering_controls"] = current.get("controls")
                details["rendered_current"] = {
                    k: current.get(k) for k in ("nodes", "unchanged_reproduced", "updated_changed",
                                                "created_rendered", "observed_numbers",
                                                "staged_numbers")}
    report.add("X-07", "Snapshot body hashes, rendered hashes and correction record", failures,
               details=details)


def check_x08(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    for node in nodes or []:
        if node.get("kind") != "epic":
            continue
        body = node.get("body") or ""
        phase = node.get("phase")
        if phase not in body:
            failures.append(f"{node.get('id')}: epic body does not name its phase {phase}")
        if not re.search(r"(?i)exit", body):
            failures.append(f"{node.get('id')}: epic body has no exit statement")
    report.add("X-08", "Epic phase as exit milestone", failures)


def _probe(check_fn, *args) -> bool:
    """True when the check reports a failure for the supplied input."""
    probe_report = Report()
    check_fn(probe_report, *args)
    return probe_report.failed


def _with_body(nodes: list[dict], node_id: str, suffix: str) -> list[dict]:
    mutated = copy.deepcopy(nodes)
    for node in mutated:
        if node.get("id") == node_id:
            node["body"] = (node.get("body") or "") + suffix
    return mutated


def check_v14(report: Report, backlog: dict | None, nodes: list[dict] | None, packets_mode: bool) -> None:
    """Negative-control self-test.

    The coverage checks above derive their expected totals from the loaded node set
    instead of asserting a literal plan size, so this check proves the derived
    assertions still bite: each deliberately broken copy of the loaded plan must be
    rejected by its check, and the unmutated copy must be accepted.
    """
    failures: list[str] = []
    details: dict = {}
    if nodes is None or backlog is None:
        report.add("V-14", "Negative-control self-test", ["no loaded plan to run the controls against"])
        return

    pristine = copy.deepcopy(nodes)
    empty_docs: dict[str, str] = {}

    duplicated = pristine + [copy.deepcopy(pristine[-1])]
    gap = [n for n in pristine if n.get("id") != "A12"]
    wrong_prefix = copy.deepcopy(pristine)
    for node in wrong_prefix:
        if node.get("id") == "A19":
            node["id"] = "B19"
    child_moved = copy.deepcopy(pristine)
    for node in child_moved:
        if node.get("id") == "C19":
            node["epic"] = "E11"
    cycle = copy.deepcopy(pristine)
    for node in cycle:
        if node.get("id") == "A19":
            node["depends_on"] = ["A24"]
    dash = _with_body(pristine, "A19", " a stray \u2014 em dash")
    private = _with_body(pristine, "A19", " see /Users/example/notes.md")
    no_baseline = copy.deepcopy(pristine)
    for node in no_baseline:
        if node.get("id") == "A19":
            node["body"] = "Short body carrying neither a link nor a baseline statement."
    stale_hash = dict(backlog, node_hashes=dict(backlog.get("node_hashes") or {}, A19="0" * 64))
    drifted_total = copy.deepcopy(backlog)
    drifted_total["nodes"] = copy.deepcopy(pristine)
    for node in drifted_total["nodes"]:
        if node.get("id") == PROGRAM_ID:
            node["body"] = re.sub(r"(\d+)\s+work items", "999 work items", node.get("body") or "")

    controls = [
        ("duplicate id is rejected", _probe(check_v01, dict(backlog, nodes=duplicated), duplicated, []),
         _probe(check_v01, backlog, pristine, [])),
        ("numbering gap is rejected", _probe(check_v04, gap), _probe(check_v04, pristine)),
        ("wrong master prefix is rejected",
         _probe(check_v04, wrong_prefix) or _probe(check_v03, wrong_prefix),
         _probe(check_v04, pristine) or _probe(check_v03, pristine)),
        ("epic child mismatch is rejected", _probe(check_v05, child_moved), _probe(check_v05, pristine)),
        ("dependency cycle is rejected", _probe(check_v06, cycle), _probe(check_v06, pristine)),
        ("dash code point is rejected", _probe(check_v10, dash, empty_docs), _probe(check_v10, pristine, empty_docs)),
        ("private path shape is rejected", _probe(check_v11, private, empty_docs),
         _probe(check_v11, pristine, empty_docs)),
        ("missing baseline is rejected", _probe(check_v12, no_baseline, empty_docs),
         _probe(check_v12, pristine, empty_docs)),
        ("stale body hash is rejected", _probe(check_x07, stale_hash, pristine, False),
         _probe(check_x07, backlog, pristine, False)),
        ("tracker total drift is rejected", _probe(check_v01, drifted_total, drifted_total["nodes"], []),
         _probe(check_v01, backlog, pristine, [])),
    ]
    details["controls"] = len(controls)
    rejected = 0
    for label, broken_rejected, pristine_rejected in controls:
        details[label] = {"broken_rejected": broken_rejected, "pristine_rejected": pristine_rejected}
        if broken_rejected:
            rejected += 1
        else:
            failures.append(f"{label}: the broken copy was accepted")
        if pristine_rejected:
            failures.append(f"{label}: the unmutated copy was rejected")
    details["rejected"] = rejected
    report.add("V-14", "Negative-control self-test", failures, details=details)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lux Didi planning integrity validator")
    parser.add_argument("--all", action="store_true", help="run every check (required)")
    parser.add_argument("--report", default="planning/backlog-validation.md", help="Markdown report path")
    parser.add_argument("--json", dest="json_path", default=None, help="JSON report path")
    parser.add_argument("--packets", dest="packets", default=None, help="directory with five per-lane issues.json packets")
    parser.add_argument("--root", default=None, help="repository root (default: parent of this script)")
    args = parser.parse_args(argv)

    if not args.all:
        parser.error("--all is required; this validator has no partial mode")

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    report_path = (root / args.report).resolve()
    json_path = (root / args.json_path).resolve() if args.json_path else report_path.with_suffix(".json")

    backlog, nodes, parse_errors = load_backlog(root, Path(args.packets).resolve() if args.packets else None)

    docs_text = read_docs_text(root)

    def inside(path: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False

    exclude = {p.relative_to(root).as_posix() for p in (report_path, json_path) if inside(p)}
    digest, walked = tree_digest(root, exclude)

    report = Report()
    check_v01(report, backlog, nodes, parse_errors)
    check_v02(report, nodes)
    check_v03(report, nodes)
    check_v04(report, nodes)
    check_v05(report, nodes)
    check_v06(report, nodes)
    check_v07(report, nodes)
    check_v08(report, nodes)
    check_v09(report, nodes)
    check_v10(report, nodes, docs_text)
    check_v11(report, nodes, docs_text)
    check_v12(report, nodes, docs_text)
    check_v13(report, root, exclude)
    check_v14(report, backlog, nodes, bool(args.packets))
    check_x01(report, nodes)
    check_x02(report, root, docs_text)
    check_x03(report, backlog, nodes)
    check_x04(report, nodes)
    check_x05(report, nodes)
    check_x06(report, backlog, nodes, bool(args.packets))
    check_x07(report, backlog, nodes, bool(args.packets))
    check_x08(report, nodes)

    commit_state = {
        "schema": "lux-didi.validation/1",
        "packets_mode": bool(args.packets),
        "tree_digest": digest,
        "file_count": len(walked),
        "failed": report.failed,
        "checks": report.checks,
    }

    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(commit_state, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    lines = [
        "# Backlog validation report",
        "",
        "Generated by `scripts/backlog_validate.py --all`. Deterministic for a fixed revision; the digest below excludes this report and its JSON twin and hashes tracked files only. The exact commit and check receipt live in the lane reports that reference this file.",
        "",
        "Structural checks only: V-08 verifies that the required section concepts are present and that body sizes are in band. It is not a content-quality proof; the independent reviewer reads every issue section substantively (R-V08-WEAK).",
        "",
        f"- Source mode: {'packets' if args.packets else 'assembled backlog'}",
        f"- Tree digest: `{digest}`",
        f"- Files scanned: {len(walked)}",
        f"- Result: {'FAIL' if report.failed else 'PASS'}",
        "",
        "| check | status | failures | warnings |",
        "| --- | --- | --- | --- |",
    ]
    for check in report.checks:
        lines.append(
            f"| {check['id']} {check['title']} | {check['status']} | {len(check['failures'])} | {len(check['warnings'])} |"
        )
    for check in report.checks:
        if not check["failures"] and not check["warnings"] and not check["details"]:
            continue
        lines.append("")
        lines.append(f"## {check['id']} {check['title']}")
        if check["details"]:
            lines.append("")
            lines.append(f"Details: `{json.dumps(check['details'], sort_keys=True)}`")
        for failure in check["failures"][:60]:
            lines.append(f"- FAIL: {failure}")
        if len(check["failures"]) > 60:
            lines.append(f"- FAIL: ... and {len(check['failures']) - 60} more")
        for warning in check["warnings"][:60]:
            lines.append(f"- WARN: {warning}")
        if len(check["warnings"]) > 60:
            lines.append(f"- WARN: ... and {len(check['warnings']) - 60} more")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    for check in report.checks:
        print(f"{check['id']} {check['status']} failures={len(check['failures'])} warnings={len(check['warnings'])}")
    print(f"tree_digest={digest} result={'FAIL' if report.failed else 'PASS'}")
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
