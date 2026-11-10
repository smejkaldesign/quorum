import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safetySettings } from '../agent.js';

describe('safetySettings', () => {
  it('passes the compiled guardrails to the read guard as flags and attaches only the included hooks that exist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-safety-'));
    mkdirSync(path.join(root, '.claude/hooks'), { recursive: true });
    writeFileSync(path.join(root, '.claude/hooks/opted-out-guard.py'), '# guard\n');
    writeFileSync(path.join(root, '.claude/hooks/tripwire.sh'), '# post\n');
    const s = safetySettings(root, {
      denyDirs: ['02-personal', 'clients/acme'], frontmatterKeys: ['confidential', 'legal_hold'], secretPattern: null, secretsOff: false,
      hooks: [{ path: path.join(root, '.claude/hooks/opted-out-guard.py'), stage: 'pre' }, { path: path.join(root, '.claude/hooks/tripwire.sh'), stage: 'post' }, { path: path.join(root, '.claude/hooks/missing.py'), stage: 'pre' }],
    });
    const guard = s.hooks.PreToolUse[0].hooks[0].command;
    expect(guard).toContain('read-guard.py');
    expect(guard).toContain('--deny "02-personal" --deny "clients/acme"');
    expect(guard).toContain('--frontmatter-key "confidential" --frontmatter-key "legal_hold"');
    expect(guard).toContain('--log-denied');
    expect(guard).not.toContain('--no-secrets');
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[1].hooks[0].command).toBe(`python3 "${path.join(root, '.claude/hooks/opted-out-guard.py')}"`);
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(`zsh "${path.join(root, '.claude/hooks/tripwire.sh')}"`);
  });
  it('turns the secret rule off or extends it when the rules say so, and runs with nothing but the built-in guard by default', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-safety-'));
    expect(safetySettings(root, { secretsOff: true }).hooks.PreToolUse[0].hooks[0].command).toContain('--no-secrets');
    expect(safetySettings(root, { secretPattern: String.raw`\.sqlite$` }).hooks.PreToolUse[0].hooks[0].command).toContain(String.raw`--secret-pattern "\.sqlite$"`);
    const plain = safetySettings(root);
    expect(plain.hooks.PreToolUse).toHaveLength(1);
    expect(plain.hooks.PostToolUse).toHaveLength(0);
  });
});
