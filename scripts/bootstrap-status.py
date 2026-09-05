#!/usr/bin/env python3
"""Bootstrap .issues-status.json by importing .done.md files."""
import sys, json, re
from pathlib import Path

ISSUES_DIR = Path(__file__).resolve().parent.parent / ".issues"
STATUS_FILE = Path(__file__).resolve().parent.parent / ".issues-status.json"

def parse_blocked_by(content):
    blocked_by = set()
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
        for m2 in re.finditer(r'`([\w][\w.-]+)`', line):
            blocked_by.add(m2.group(1))
        for m2 in re.finditer(r'\[([\w][\w.-]+)\]', line):
            blocked_by.add(m2.group(1))
        for m2 in re.finditer(r'#(\d+(?:-[\w.-]+)?)\s*[—–-]', line):
            blocked_by.add(m2.group(1))
    blocked_by = {b for b in blocked_by if b not in ("None", "can", "start", "immediately")}
    return list(blocked_by)

def main():
    if not ISSUES_DIR.exists():
        print(f"❌ Issues directory not found: {ISSUES_DIR}")
        sys.exit(1)

    if STATUS_FILE.exists():
        status = json.loads(STATUS_FILE.read_text())
    else:
        status = {}

    count = 0
    all_count = 0
    for prd_dir in sorted(ISSUES_DIR.iterdir()):
        if not prd_dir.is_dir():
            continue
        for f in sorted(prd_dir.glob("*.md")):
            all_count += 1
            key = f"{prd_dir.name}/{f.name}"
            if key.endswith(".done.md") and key not in status:
                status[key] = {"done": True, "completed_at": "auto-imported"}
                count += 1

    STATUS_FILE.write_text(json.dumps(status, indent=2, ensure_ascii=False))
    print(f"✅ Imported {count} .done.md issues as completed")
    print(f"📊 {all_count} total issues, {len(status)} tracked in status")

if __name__ == "__main__":
    main()
