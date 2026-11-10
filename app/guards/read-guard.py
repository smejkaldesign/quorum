#!/usr/bin/env python3
"""Quorum's built-in read guard: a Claude Code PreToolUse hook for Read, Grep and Glob.

Denies reads of secret-looking files, of folders the user marked private, and of notes whose
frontmatter carries a `confidential:` key. Ships with the app, so every Agent OS gets it even
when the connected repo has no guard hooks of its own.

usage: read-guard.py --root <agent os root> [--deny <relative dir>]... [--frontmatter-key <key>]...
       [--secret-pattern <regex>] [--no-secrets] [--log <views.jsonl>] [--log-denied <denials.jsonl>]

The flags are the compiled guardrails (app/guardrails.js): folders to deny, frontmatter keys that mark a note
off limits (default: confidential), the secret file-name pattern (default below, --no-secrets turns it off).
With --log, every allowed Read of a markdown note is appended to that file as one JSON line, which is how
Quorum counts agent views of a note. With --log-denied, every denial is appended the same way for the
Guardrails page.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

SECRET_NAMES = re.compile(r"(^|/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa)(\.pub)?|.*secret.*|.*credential.*|.*\.token|google-client-secret\.json)$", re.I)
ALWAYS_DENY_DIRS = (".git", "node_modules")


DENIED_LOG = None


def deny(reason, tool="", target=""):
    if DENIED_LOG:
        try:
            with open(DENIED_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tool": tool, "path": target, "reason": reason}) + "\n")
        except OSError:
            pass
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
    sys.exit(0)


def args():
    global DENIED_LOG
    root, deny_dirs, log, keys, secret, no_secrets = None, [], None, [], None, False
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--root":
            root = next(it, None)
        elif a == "--deny":
            deny_dirs.append(next(it, ""))
        elif a == "--log":
            log = next(it, None)
        elif a == "--log-denied":
            DENIED_LOG = next(it, None)
        elif a == "--frontmatter-key":
            keys.append((next(it, "") or "").strip().lower())
        elif a == "--secret-pattern":
            secret = next(it, None)
        elif a == "--no-secrets":
            no_secrets = True
    return root or os.getcwd(), [d.strip("/") for d in deny_dirs if d.strip("/")], log, [k for k in keys if k] or ["confidential"], secret, no_secrets


def log_read(log, abs_path):
    """One line per allowed note read; the guard never fails a read over its own bookkeeping."""
    if not log or not abs_path.endswith(".md"):
        return
    try:
        size = os.path.getsize(abs_path)
        line = {"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "file": os.path.realpath(abs_path), "who": "agent", "via": "claude-code", "bytes": size}
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
    except OSError:
        pass


def rel_to(root, p):
    if not p:
        return None
    ap = os.path.realpath(p if os.path.isabs(p) else os.path.join(root, p))
    rr = os.path.realpath(root)
    return os.path.relpath(ap, rr) if ap == rr or ap.startswith(rr + os.sep) else ap


def in_dir(rel, d):
    return rel == d or rel.startswith(d + os.sep) or ("/" + d + "/") in ("/" + rel + "/")


def frontmatter_key(abs_path, keys):
    """The first of `keys` present in the note's frontmatter, or None."""
    try:
        with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(2048)
    except OSError:
        return None
    if not head.startswith("---"):
        return None
    end = head.find("\n---", 3)
    block = head[3:end if end > 0 else len(head)]
    for k in keys:
        if re.search(r"^\s*" + re.escape(k) + r"\s*:", block, re.M | re.I):
            return k
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    tool = data.get("tool_name")
    if tool not in ("Read", "Grep", "Glob"):
        sys.exit(0)
    root, deny_dirs, log, keys, secret, no_secrets = args()
    secret_re = None if no_secrets and not secret else (re.compile(secret, re.I) if secret else SECRET_NAMES)
    inp = data.get("tool_input", {}) or {}
    target = inp.get("file_path") or inp.get("path") or ""
    rel = rel_to(root, target)
    if rel is None:
        if tool == "Read":
            sys.exit(0)
        rel = "."
    for d in ALWAYS_DENY_DIRS + tuple(deny_dirs):
        if in_dir(rel, d):
            deny(f"Quorum read guard: {d}/ is private to this Agent OS.", tool, rel)
    if secret_re is not None and secret_re.search(rel):
        deny("Quorum read guard: that file looks like a secret or credential.", tool, rel)
    if tool == "Read":
        abs_path = target if os.path.isabs(target) else os.path.join(root, target)
        hit = frontmatter_key(abs_path, keys)
        if hit:
            deny(f"Quorum read guard: this note is marked {hit} in its frontmatter.", tool, rel)
        log_read(log, abs_path)
    # a Grep or Glob rooted above a private folder would still match files inside it, so the pattern must not name one
    if tool in ("Grep", "Glob"):
        pat = str(inp.get("pattern") or "") + " " + str(inp.get("glob") or "")
        for d in deny_dirs:
            if d.lower() in pat.lower():
                deny(f"Quorum read guard: {d}/ is private to this Agent OS.", tool, rel)
    sys.exit(0)


if __name__ == "__main__":
    main()
