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
integration checks (X-01 to X-06) defined for the assembled backlog.

Definitions used by the checks:
    V-08 word band: tasks are expected in the 300 to 650 word target band; the
        band is reported with outliers named, a task under 250 words fails as
        too thin, and a task over 900 words fails as padding. V-08 also checks
        that each task body contains the required section concepts. That is a
        presence and size check only: it is not proof of content quality, and
        the independent reviewer reads every section substantively (R-V08-WEAK).
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
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = "lux-didi.backlog/1"

MILESTONES = {
    "M0": "Proof and contracts",
    "M1": "Useful daily loop",
    "M2": "Voice and proactive beta",
    "M3": "Controlled execution and integrations",
    "M4": "Portability and polish",
}

# epic -> (master, expected child count)
EPICS = {
    "E01": ("A", 8),
    "E02": ("A", 10),
    "E03": ("B", 9),
    "E04": ("B", 9),
    "E05": ("C", 11),
    "E06": ("C", 7),
    "E07": ("D", 9),
    "E08": ("D", 9),
    "E09": ("E", 9),
    "E10": ("E", 9),
}

# master -> id prefixes
MASTER_PREFIX = {"A": "A", "B": "B", "C": "C", "D": "D", "E": "F"}

EXPECTED_IDS = (
    {"P00"}
    | {f"E{i:02d}" for i in range(1, 11)}
    | {f"A{i:02d}" for i in range(1, 19)}
    | {f"B{i:02d}" for i in range(1, 19)}
    | {f"C{i:02d}" for i in range(1, 19)}
    | {f"D{i:02d}" for i in range(1, 19)}
    | {f"F{i:02d}" for i in range(1, 19)}
)

DOCS = [
    "architecture.md",
    "roadmap.md",
    "parallel-masters.md",
    "research.md",
    "privacy-and-authority.md",
    "acceptance.md",
    "decisions.md",
    "risks.md",
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
    "planning/backlog.json",
    "planning/backlog-validation.md",
    "planning/backlog-validation.json",
    "planning/issue-map.json",
}
ALLOWED_PATHS |= {f"docs/{name}" for name in DOCS}


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
    if len(nodes) != 101:
        failures.append(f"expected 101 nodes, found {len(nodes)}")
    if kinds.count("program") != 1:
        failures.append(f"expected exactly 1 program tracker, found {kinds.count('program')}")
    if kinds.count("epic") != 10:
        failures.append(f"expected exactly 10 epics, found {kinds.count('epic')}")
    if kinds.count("task") != 90:
        failures.append(f"expected exactly 90 tasks, found {kinds.count('task')}")
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        failures.append(f"duplicate ids: {duplicates}")
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
    ids = [n.get("id") for n in nodes or []]
    expected = set(EXPECTED_IDS)
    missing = sorted(expected - set(ids))
    extra = sorted(set(ids) - expected)
    if missing:
        failures.append(f"missing ids: {missing}")
    if extra:
        failures.append(f"unexpected ids: {extra}")
    report.add("V-04", "Id format and complete coverage", failures, details={"count": len(ids), "expected": len(expected)})


def check_v05(report: Report, nodes: list[dict] | None) -> None:
    failures: list[str] = []
    by_id = {n.get("id"): n for n in nodes or []}
    children: dict[str, list[str]] = {e: [] for e in EPICS}
    for node in nodes or []:
        node_id = node.get("id")
        kind = node.get("kind")
        epic = node.get("epic")
        if kind == "task":
            if epic not in EPICS:
                failures.append(f"{node_id}: epic {epic!r} is not an E01..E10 value")
                continue
            children[epic].append(node_id)
            expected_master = EPICS[epic][0]
            if node.get("master") != expected_master:
                failures.append(f"{node_id}: master {node.get('master')!r} does not match epic {epic} (master {expected_master})")
        else:
            if epic is not None:
                failures.append(f"{node_id}: epic must be null for kind {kind}")
    for epic, (_, expected_count) in EPICS.items():
        kids = sorted(children.get(epic, []))
        if len(kids) != expected_count:
            failures.append(f"{epic}: expected {expected_count} children, found {len(kids)}")
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
    walked = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if path.is_dir():
            continue
        if rel.startswith(".git/") or rel == ".git":
            continue
        walked.append(rel)
        if rel in exclude:
            continue
        if rel not in ALLOWED_PATHS:
            failures.append(f"unexpected published path: {rel}")
    for name in DOCS:
        rel = f"docs/{name}"
        if rel not in walked:
            failures.append(f"missing document {rel}")
    for required in ["README.md", "scripts/backlog_validate.py", "planning/backlog.json"]:
        if required not in walked:
            failures.append(f"missing {required}")
    if (root / ".github" / "workflows").exists():
        failures.append(".github/workflows exists")
    for name in walked:
        base = os.path.basename(name).lower()
        if base.startswith(".env") or base in {"credentials.json", "secrets.json"} or base.endswith(".pem"):
            failures.append(f"credential-shaped file: {name}")
    report.add("V-13", "Repository hygiene and intended public set", failures, warnings, details={"paths": walked})


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
        report.add("X-07", "Snapshot body hashes and correction record", [])
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
    report.add("X-07", "Snapshot body hashes and correction record", failures, details=details)


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

    docs_text: dict[str, str] = {}
    readme = root / "README.md"
    if readme.exists():
        docs_text["README.md"] = readme.read_text(encoding="utf-8")
    for name in DOCS:
        path = root / "docs" / name
        if path.exists():
            docs_text[f"docs/{name}"] = path.read_text(encoding="utf-8")

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
