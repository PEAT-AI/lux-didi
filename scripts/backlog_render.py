#!/usr/bin/env python3
"""Render-only backlog publishing helper.

Reproduces the published issue-body rendering exactly as the baseline publisher did,
without any network call and without writing to the tracker. Two verifications run:

- baseline: read planning/backlog.json and planning/issue-map.json at a git ref and
  reproduce every recorded ``rendered_body_sha256`` from that map.
- current: render the working-tree nodes with the supplied id map, and check that an
  unchanged node reproduces its observed rendered hash, an updated node produces a new
  one, and a created node renders under a staged number that collides with nothing.

Rendering recipe, unchanged from the verified publisher:
    canonical_body_sha256 = sha256(node["body"])
    rendered_body_sha256  = sha256(render_body(node, numbers, children))
where ``numbers`` maps a stable id to its issue number and ``children`` maps an epic id
to its child task ids in backlog order.

Usage:
    python3 scripts/backlog_render.py --check [--json]
    python3 scripts/backlog_render.py --check --baseline-ref <ref>
    python3 scripts/backlog_render.py --render <out-dir> [--ref <ref>]

Exit status is non-zero when any verification fails. This script never calls the
network and never writes a report into the repository.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = "PEAT-AI/lux-didi"
REPO_URL = f"https://github.com/{REPO}"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE_REF = "8f6a851767fc5c1a94f11aa2108498ec8bfa5612"

# The token form the baseline publisher linked, kept byte-identical.
TOKEN_RE = re.compile(r"(?<![\w/#\[])(P00|E\d{2}|[A-F]\d{2})(?![\w\]])")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def readback_sha(body: str) -> str:
    return sha(body.replace("\r\n", "\n"))


def canonical_body_sha256(body: str) -> str:
    return hashlib.sha256((body or "").encode("utf-8")).hexdigest()


def linkify(text: str, numbers: dict[str, int]) -> str:
    def repl(match: re.Match) -> str:
        token = match.group(1)
        number = numbers.get(token)
        if not number:
            return token
        return f"[{token}]({REPO_URL}/issues/{number})"

    return TOKEN_RE.sub(repl, text)


def render_body(node: dict, numbers: dict[str, int], children: dict[str, list[str]]) -> str:
    body = linkify(node["body"], numbers)
    node_id = node["id"]
    kind = node["kind"]
    lines: list[str] = []
    if kind == "task":
        epic = node.get("epic")
        epic_ref = f"#{numbers[epic]}" if epic and epic in numbers else "none"
        deps = node.get("depends_on") or []
        dep_ref = ", ".join(f"#{numbers[d]}" for d in deps if d in numbers) or "none"
        lines.append(f"Epic: {epic_ref} | Depends on: {dep_ref}")
    elif kind == "epic":
        kids = children.get(node_id, [])
        lines.append("Children: " + ", ".join(f"#{numbers[k]}" for k in kids if k in numbers))
    elif kind == "program":
        epics = [f"#{numbers[e]}" for e in sorted(numbers) if e.startswith("E") and e in numbers]
        lines.append("Epic index: " + ", ".join(epics))
    if lines:
        body += "\n\n---\n" + "\n".join(lines)
    body += f"\n\n<!-- lux-didi-id: {node_id} -->"
    return body


def numbers_from_map(issue_map: dict) -> dict[str, int]:
    return {node_id: entry["number"]
            for node_id, entry in issue_map["nodes"].items()
            if isinstance(entry.get("number"), int)}


def children_of(nodes: list[dict]) -> dict[str, list[str]]:
    children: dict[str, list[str]] = {}
    for node in nodes:
        if node["kind"] == "task" and node.get("epic"):
            children.setdefault(node["epic"], []).append(node["id"])
    return children


def git_show(ref: str, path: str) -> str:
    out = subprocess.run(["git", "-C", str(ROOT), "show", f"{ref}:{path}"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"cannot read {path} at {ref}: {out.stderr.strip()}")
    return out.stdout


def render_all(nodes: list[dict], numbers: dict[str, int]) -> dict[str, str]:
    children = children_of(nodes)
    return {node["id"]: readback_sha(render_body(node, numbers, children)) for node in nodes}


def verify_baseline(ref: str) -> dict:
    backlog = json.loads(git_show(ref, "planning/backlog.json"))
    issue_map = json.loads(git_show(ref, "planning/issue-map.json"))
    nodes = backlog["nodes"]
    rendered = render_all(nodes, numbers_from_map(issue_map))
    mismatched = []
    recorded = 0
    for node_id, value in sorted(rendered.items()):
        expected = (issue_map["nodes"].get(node_id) or {}).get("rendered_body_sha256")
        if not expected:
            continue
        recorded += 1
        if expected != value:
            mismatched.append(node_id)
    return {"ref": ref, "nodes": len(nodes), "recorded": recorded,
            "matched": recorded - len(mismatched), "mismatched": mismatched}


def verify_current() -> dict:
    backlog = json.loads((ROOT / "planning" / "backlog.json").read_text(encoding="utf-8"))
    issue_map = json.loads((ROOT / "planning" / "issue-map.json").read_text(encoding="utf-8"))
    nodes = backlog["nodes"]
    numbers = numbers_from_map(issue_map)
    rendered = render_all(nodes, numbers)

    observed_numbers = set()
    staged_numbers = set()
    mismatched: list[str] = []
    counts = {"unchanged_reproduced": 0, "updated_changed": 0, "created_rendered": 0}
    for node in nodes:
        node_id = node["id"]
        entry = issue_map["nodes"].get(node_id) or {}
        observed = entry.get("observed")
        observed_rendered = (observed or {}).get("rendered_body_sha256")
        if observed is None:
            counts["created_rendered"] += 1
            staged_numbers.add(entry.get("number"))
            continue
        observed_numbers.add(observed.get("number"))
        body_hash = canonical_body_sha256(node["body"])
        unchanged = body_hash == observed.get("canonical_body_sha256")
        if unchanged:
            counts["unchanged_reproduced"] += 1
            if observed_rendered and rendered[node_id] != observed_rendered:
                mismatched.append(node_id)
            if entry.get("rendered_body_sha256") and entry["rendered_body_sha256"] != rendered[node_id]:
                mismatched.append(node_id)
        else:
            counts["updated_changed"] += 1
            if observed_rendered and rendered[node_id] == observed_rendered:
                mismatched.append(node_id)
    collisions = sorted(
        n for n in {k for k in numbers.values() if isinstance(k, int)}
        if n in observed_numbers and n in staged_numbers)
    return {
        "nodes": len(nodes),
        "observed_numbers": len({n for n in observed_numbers if isinstance(n, int)}),
        "staged_numbers": len({n for n in staged_numbers if isinstance(n, int)}),
        "staged_number_collisions": collisions,
        "mismatched": sorted(set(mismatched)),
        **counts,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render-only Lux Didi backlog helper")
    parser.add_argument("--check", action="store_true", help="run both verifications")
    parser.add_argument("--baseline-ref", default=DEFAULT_BASELINE_REF)
    parser.add_argument("--render", default=None, help="write rendered bodies into this directory")
    parser.add_argument("--ref", default=None, help="ref to render with --render")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    args = parser.parse_args(argv)

    if args.render:
        out_dir = Path(args.render)
        out_dir.mkdir(parents=True, exist_ok=True)
        if args.ref:
            nodes = json.loads(git_show(args.ref, "planning/backlog.json"))["nodes"]
            numbers = numbers_from_map(json.loads(git_show(args.ref, "planning/issue-map.json")))
        else:
            nodes = json.loads((ROOT / "planning" / "backlog.json").read_text(encoding="utf-8"))["nodes"]
            numbers = numbers_from_map(json.loads(
                (ROOT / "planning" / "issue-map.json").read_text(encoding="utf-8")))
        children = children_of(nodes)
        for node in nodes:
            (out_dir / f"_render_{node['id']}.md").write_text(
                render_body(node, numbers, children), encoding="utf-8")
        print(f"rendered {len(nodes)} bodies into {out_dir}")
        return 0

    if not args.check:
        parser.error("--check or --render is required; this helper has no other mode")

    baseline = verify_baseline(args.baseline_ref)
    current = verify_current()
    ok = (not baseline["mismatched"] and baseline["recorded"] > 0
          and not current["mismatched"] and not current["staged_number_collisions"]
          and current["created_rendered"] > 0)
    result = {"ok": ok, "baseline": baseline, "current": current}
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(f"baseline {baseline['matched']}/{baseline['recorded']} rendered hashes reproduced "
              f"at {baseline['ref'][:12]}")
        print(f"current {current['nodes']} nodes: {current['unchanged_reproduced']} unchanged "
              f"reproduced, {current['updated_changed']} updated changed, "
              f"{current['created_rendered']} created rendered, "
              f"numbers observed {current['observed_numbers']} and staged "
              f"{current['staged_numbers']}")
        if baseline["mismatched"]:
            print(f"baseline mismatched: {baseline['mismatched'][:10]}")
        if current["mismatched"]:
            print(f"current mismatched: {current['mismatched'][:10]}")
        if current["staged_number_collisions"]:
            print(f"staged number collisions: {current['staged_number_collisions']}")
        print("result=" + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
