#!/usr/bin/env python3
"""
Issue Orchestrator for study-helper.

Scans .issues/ for PRD folders, builds a dependency graph from "Blocked by"
sections in each issue, tracks execution status, and determines what's ready.

Usage:
  python3 scripts/issue-orchestrator.py status       # Show current status
  python3 scripts/issue-orchestrator.py next         # Show next ready issue(s)
  python3 scripts/issue-orchestrator.py mark <path>  # Mark an issue as done
  python3 scripts/issue-orchestrator.py graph        # DOT graph for visualization
  python3 scripts/issue-orchestrator.py dag          # Topological sort (execution order)
"""

import json
import os
import re
import sys
from pathlib import Path
from collections import defaultdict, deque

ISSUES_DIR = Path(__file__).resolve().parent.parent / ".issues"
STATUS_FILE = Path(__file__).resolve().parent.parent / ".issues-status.json"

PRD_ORDER = [
    "20260513-001-fix-parseFixedDiagrams-panic-and-complete-test-suite",
    "20260513-002-mermaid-validation-repair-pipeline",
    "20260513-003-mermaid-migration-go-mermaid-to-nao1215-markdown",
    "20260513-004-migrate-to-nao1215-markdown-for-all-generation",
    "20260514-001-complete-mermaid-migration-remaining-work",
    "20260514-002-structured-lesson-pipeline",
    "20260514-003-mermaid-json-tolerance-and-skill-removal",
    "20260514-004-remove-mermaid-formatting-use-lib-output-as-is",
    "20260514-005-fix-temp-file-contract-and-process-tests",
    "20260514-006-two-phase-lesson-and-diagram-pipeline",
    "20260514-007-streaming-view-ux-fixes-and-save-dock",
    "20260515-001-live-mode-ux-overhaul",
    "20260516-001-explanation-mode-dock-restructure-and-ux-fixes",
    "20260516-002-e2e-playwright-tests",
]


def load_status():
    if STATUS_FILE.exists():
        return json.loads(STATUS_FILE.read_text())
    return {}


def save_status(status):
    STATUS_FILE.write_text(json.dumps(status, indent=2, ensure_ascii=False))
    print(f"  [ok] Status saved to {STATUS_FILE}", file=sys.stderr)


def scan_issues():
    """Scan .issues/ and return all PRD folders with their issues."""
    prds = {}
    for prd_dir in sorted(ISSUES_DIR.iterdir()):
        if not prd_dir.is_dir():
            continue
        issues = []
        for f in sorted(prd_dir.glob("*.md")):
            content = f.read_text(encoding="utf-8")
            issues.append({
                "path": str(f.relative_to(ISSUES_DIR)),
                "abspath": str(f),
                "filename": f.name,
                "prd": prd_dir.name,
                "title": f.stem,
                "content": content,
                "blocked_by": parse_blocked_by(content),
            })
        if issues:
            prds[prd_dir.name] = issues
    return prds


def parse_blocked_by(content):
    """Parse ## Blocked by section and return list of blocking issue references."""
    blocked_by = set()

    # Match ## Blocked by section
    m = re.search(r'^## Blocked by\s*\n(.*?)(?=^## |\Z)', content, re.MULTILINE | re.DOTALL)
    if not m:
        return []

    section = m.group(1).strip()
    if not section or section.lower().startswith("none"):
        return []

    for line in section.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        # Patterns to extract references:
        # `20260514-01` (backtick-wrapped)
        for m2 in re.finditer(r'`([\w][\w.-]+)`', line):
            blocked_by.add(m2.group(1))
        # [20260514-43] (bracket-wrapped)
        for m2 in re.finditer(r'\[([\w][\w.-]+)\]', line):
            blocked_by.add(m2.group(1))
        # #001-e2e-package... or #1 — (hash-prefixed references)
        for m2 in re.finditer(r'#(\d+(?:-[\w.-]+)?)\s*[—–-]', line):
            blocked_by.add(m2.group(1))

    # Filter out noise
    blocked_by = {b for b in blocked_by if b not in ("None", "can", "start", "immediately")}
    return list(blocked_by)


def resolve_issue_key(prd, issues):
    """Map partial references to full issue keys."""
    # Build map: filename stem -> full key
    key_map = {}
    for issue in issues:
        stem = issue["title"]
        # Remove leading numbers like "20260513-01-..."
        key_map[stem] = f"{issue['prd']}/{issue['filename']}"
        # Also map by just the number part
        num_m = re.match(r'(\d+)', stem)
        if num_m:
            key_map[num_m.group(1)] = f"{issue['prd']}/{issue['filename']}"
        # Map by full slug after date
        slug_m = re.match(r'\d+-(.+)', stem)
        if slug_m:
            key_map[slug_m.group(1)] = f"{issue['prd']}/{issue['filename']}"

    return key_map


def build_graph(prds):
    """Build full dependency graph across all PRDs."""
    # All issue keys: "prd_name/filename"
    all_issues = {}
    for prd_name, issues in prds.items():
        for issue in issues:
            key = f"{prd_name}/{issue['filename']}"
            all_issues[key] = issue

    # Build global key map
    global_key_map = {}
    for prd_name, issues in prds.items():
        key_map = resolve_issue_key(prd_name, issues)
        for partial, full in key_map.items():
            global_key_map[partial] = full

    # Resolve dependencies
    deps = {}  # issue_key -> list of blocking issue_keys
    for key, issue in all_issues.items():
        resolved = []
        for ref in issue["blocked_by"]:
            # Try direct match
            if ref in all_issues:
                resolved.append(ref)
            # Try partial match
            elif ref in global_key_map:
                resolved.append(global_key_map[ref])
            # Try within same PRD with partial name
            else:
                # Search within same PRD
                prd_name = issue["prd"]
                for candidate_key, candidate in all_issues.items():
                    if candidate["prd"] == prd_name and ref in candidate["title"]:
                        resolved.append(candidate_key)
                        break
        deps[key] = resolved

    return all_issues, deps


def compute_ready(all_issues, deps, status):
    """Compute which issues are ready to execute (all deps met, not done)."""
    ready = []
    blocked = []

    for key, issue in all_issues.items():
        if status.get(key, {}).get("done"):
            continue

        unresolved = []
        for dep in deps[key]:
            dep_status = status.get(dep, {})
            if not dep_status.get("done"):
                unresolved.append(dep)

        if not unresolved:
            ready.append(key)
        else:
            blocked.append((key, unresolved))

    # Sort ready by PRD order then by filename
    def sort_key(k):
        prd_name = k.split("/")[0]
        try:
            prd_idx = PRD_ORDER.index(prd_name)
        except ValueError:
            prd_idx = 999
        return (prd_idx, k)

    ready.sort(key=sort_key)
    blocked.sort(key=lambda x: sort_key(x[0]))

    return ready, blocked


def cmd_status():
    prds = scan_issues()
    status = load_status()

    all_issues, deps = build_graph(prds)
    ready, blocked = compute_ready(all_issues, deps, status)

    total = len(all_issues)
    done_count = sum(1 for k in all_issues if status.get(k, {}).get("done"))
    pct = (done_count / total * 100) if total > 0 else 0

    print(f"📊 Issue Status: {done_count}/{total} done ({pct:.0f}%)")
    print()

    if ready:
        print("✅ Ready to execute:")
        for key in ready:
            print(f"   {key}")
    else:
        print("⚠️  No issues ready (all done or all blocked)")
        print()

    if blocked:
        print("🔒 Blocked:")
        for key, blockers in blocked[:10]:
            bnames = ", ".join(blockers[:3])
            extra = f" +{len(blockers)-3} more" if len(blockers) > 3 else ""
            print(f"   {key}  <- {bnames}{extra}")
        if len(blocked) > 10:
            print(f"   ... and {len(blocked) - 10} more blocked issues")

    print()
    print("💡 Run 'python3 scripts/issue-orchestrator.py next' for execution order")


def cmd_next():
    prds = scan_issues()
    status = load_status()
    all_issues, deps = build_graph(prds)
    ready, _ = compute_ready(all_issues, deps, status)

    if not ready:
        print("⚠️  No issues ready to execute.")
        return

    print(f"📋 Next {min(len(ready), 5)} issue(s) to execute:\n")
    for key in ready[:5]:
        issue = all_issues[key]
        print(f"   📄 {key}")
        print(f"      Path: {issue['abspath']}")
        print()


def cmd_mark(issue_path):
    """Mark an issue as done."""
    status = load_status()

    # Normalize path: could be relative to .issues/ or absolute
    if issue_path.startswith("/"):
        try:
            rel = Path(issue_path).relative_to(ISSUES_DIR)
        except ValueError:
            print(f"❌ Path {issue_path} is not under {ISSUES_DIR}")
            return 1
    else:
        rel = Path(issue_path)

    key = str(rel)
    if key not in status:
        # Verify it exists
        full_path = ISSUES_DIR / rel
        if not full_path.exists():
            print(f"❌ Issue not found: {full_path}")
            return 1

    status[key] = {"done": True, "completed_at": __import__("datetime").datetime.now().isoformat()}
    save_status(status)
    print(f"✅ Marked as done: {key}")
    return 0


def cmd_graph():
    """Output DOT graph for visualization."""
    prds = scan_issues()
    status = load_status()
    all_issues, deps = build_graph(prds)

    print("digraph Issues {")
    print("  rankdir=LR;")
    print("  node [shape=box, style=rounded];")
    print()

    # Group by PRD
    prd_groups = defaultdict(list)
    for key in all_issues:
        prd_name = key.split("/")[0]
        prd_groups[prd_name].append(key)

    for prd_name, keys in prd_groups.items():
        safe_name = prd_name.replace("-", "_").replace(".", "_")
        print(f"  subgraph cluster_{safe_name} {{")
        print(f'    label = "{prd_name}";')
        print(f'    style = "rounded,dashed";')
        for key in keys:
            done = status.get(key, {}).get("done", False)
            color = "green" if done else "white"
            print(f'    "{key}" [style=filled, fillcolor={color}];')
        print("  }")
        print()

    for key, blockers in deps.items():
        for b in blockers:
            if b in all_issues:
                print(f'  "{b}" -> "{key}";')

    print("}")


def cmd_dag():
    """Compute and display topological sort."""
    prds = scan_issues()
    status = load_status()
    all_issues, deps = build_graph(prds)

    # Kahn's algorithm
    in_degree = {k: len(deps[k]) for k in all_issues}
    adj = defaultdict(list)
    for k, blockers in deps.items():
        for b in blockers:
            if b in all_issues:
                adj[b].append(k)

    queue = deque([k for k, d in in_degree.items() if d == 0])
    order = []

    while queue:
        node = queue.popleft()
        order.append(node)
        for neighbor in adj[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if len(order) != len(all_issues):
        print("⚠️  Cycle detected! Partial order:")
    else:
        print("📋 Execution order (topological sort):")

    for i, key in enumerate(order, 1):
        done = "✅" if status.get(key, {}).get("done") else "⬜"
        print(f"  {i:3d}. {done} {key}")


def main():
    if not ISSUES_DIR.exists():
        print(f"❌ Issues directory not found: {ISSUES_DIR}")
        sys.exit(1)

    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "status":
        cmd_status()
    elif cmd == "next":
        cmd_next()
    elif cmd == "mark":
        if len(sys.argv) < 3:
            print("Usage: issue-orchestrator.py mark <relative_path>")
            print("Example: issue-orchestrator.py mark 20260513-001-fix-parseFixedDiagrams-panic-and-complete-test-suite/20260513-01-fix-parseFixedDiagrams-panic.md")
            sys.exit(1)
        sys.exit(cmd_mark(sys.argv[2]))
    elif cmd == "graph":
        cmd_graph()
    elif cmd == "dag":
        cmd_dag()
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
