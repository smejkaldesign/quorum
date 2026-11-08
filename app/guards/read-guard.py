#!/usr/bin/env python3
"""Quorum's built-in read guard: a Claude Code PreToolUse hook for Read, Grep and Glob.

Denies reads of secret-looking files, of folders the user marked private, and of notes whose
frontmatter carries a `confidential:` key. Ships with the app, so every Agent OS gets it even
when the connected repo has no guard hooks of its own.

usage: read-guard.py --root <agent os root> [--deny <relative dir>]...
"""

import json
import os
import re
import sys

SECRET_NAMES = re.compile(r"(^|/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa)(\.pub)?|.*secret.*|.*credential.*|.*\.token|google-client-secret\.json)$", re.I)
ALWAYS_DENY_DIRS = (".git", "node_modules")


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
    sys.exit(0)


def args():
    root, deny_dirs = None, []
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--root":
            root = next(it, None)
        elif a == "--deny":
            deny_dirs.append(next(it, ""))
    return root or os.getcwd(), [d.strip("/") for d in deny_dirs if d.strip("/")]


def rel_to(root, p):
    if not p:
        return None
    ap = os.path.realpath(p if os.path.isabs(p) else os.path.join(root, p))
    rr = os.path.realpath(root)
    return os.path.relpath(ap, rr) if ap == rr or ap.startswith(rr + os.sep) else ap


def in_dir(rel, d):
    return rel == d or rel.startswith(d + os.sep) or ("/" + d + "/") in ("/" + rel + "/")


def frontmatter_confidential(abs_path):
    try:
        with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(2048)
    except OSError:
        return False
    if not head.startswith("---"):
        return False
    end = head.find("\n---", 3)
    block = head[3:end if end > 0 else len(head)]
    return re.search(r"^\s*confidential\s*:", block, re.M | re.I) is not None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    tool = data.get("tool_name")
    if tool not in ("Read", "Grep", "Glob"):
        sys.exit(0)
    root, deny_dirs = args()
    inp = data.get("tool_input", {}) or {}
    target = inp.get("file_path") or inp.get("path") or ""
    rel = rel_to(root, target)
    if rel is None:
        if tool == "Read":
            sys.exit(0)
        rel = "."
    for d in ALWAYS_DENY_DIRS + tuple(deny_dirs):
        if in_dir(rel, d):
            deny(f"Quorum read guard: {d}/ is private to this Agent OS.")
    if SECRET_NAMES.search(rel):
        deny("Quorum read guard: that file looks like a secret or credential.")
    if tool == "Read":
        abs_path = target if os.path.isabs(target) else os.path.join(root, target)
        if frontmatter_confidential(abs_path):
            deny("Quorum read guard: this note is marked confidential in its frontmatter.")
    # a Grep or Glob rooted above a private folder would still match files inside it, so the pattern must not name one
    if tool in ("Grep", "Glob"):
        pat = str(inp.get("pattern") or "") + " " + str(inp.get("glob") or "")
        for d in deny_dirs:
            if d.lower() in pat.lower():
                deny(f"Quorum read guard: {d}/ is private to this Agent OS.")
    sys.exit(0)


if __name__ == "__main__":
    main()
