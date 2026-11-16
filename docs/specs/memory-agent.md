# Memory agent

Status: the local agent is built through Sprint 4 (past-fix re-check). Team vault mode is a spec only. Related: [team-knowledge.md](team-knowledge.md), [workspace-knowledge.md](workspace-knowledge.md).

The memory agent keeps a vault's links and notes in good shape. It finds problems, proposes a fix for each, and changes a note only after a person approves. Every fix can be traced and undone.

## Local agent

### Detectors

A detector is a rule with an id and a version. The version goes up when the fix a finding gets can change. Each decision records both, so a later version can tell which rule made a finding.

- `link.missing` (version 2, `app/linkRules.js`, `app/memoryHealth.js`). A link opens no note. The fix is one of: add an alias, point the links at an existing note, write the missing note, remove the link and keep its words, or leave it.
- Generated notes. Logs, reports and notes whose frontmatter marks them as generated are never a source of a missing link. Quorum never edits one to fix a link, and never points a link at one. Each rule in `GENERATED_RULES` names what it matches and why.
- Titles. A note's title is its frontmatter title or first heading, cut at a saved `\n` and at 120 characters.
- Existence check (`app/linkElsewhere.js`). Before Quorum offers to write a note, it looks for a folder, script, skill or repo file with that name, and for a note at that name on another local git branch. A folder with an index note gets a relink instead.
- Writing a note needs at least two linking notes a person wrote. It goes in the folder most of them sit in. It never goes in `memory/sessions` or `memory/eval`. It carries the confidential mark of its sources.

Sprint 2 adds review-only rules, each with its own id: orphans, exact duplicates, frontmatter schema per folder, oversized notes, confidential mark versus folder, secrets, and stale notes.

### Fix pipeline

1. A person approves one finding, or a selection of findings.
2. A bulk Approve skips review-only fixes. Writing a note and a weak match are review-only.
3. Each approved fix becomes a run in one queue. Runs go one at a time.
4. The run records the hash of every note it will touch. It refuses to write a note whose text changed since the finding.
5. It refuses when the fix the finding gets now differs from the fix the person approved.
6. Before each write, the run saves the note's text in an undo record on disk.
7. After the write, Quorum checks the links of every touched note again. A fix that left a new broken link, a missing target or the same dead link is rolled back and marked Failed.
8. Each changed note gets a new version in its history (`app/memoryVersions.js`).

### Run journal and recovery

Each run appends one line per step to a journal in the app data folder (`app/fixJournal.js`). A run still queued or running when Quorum quit is recovered on the next start. The notes it wrote go back from its undo record. A note the person edited since is left as it is. The run is marked Failed with a plain reason.

### Undo

Undo on a finished fix puts each note back and moves a note the fix wrote to the Trash. It refuses when any note changed after the fix, so later edits are never lost. The finding goes back to Needs review.

### Decision log

Approve, Archive, Undo and Move back to review each add a record (`app/decisionLog.js`). A record holds the rule id, rule version, a fingerprint of the finding, the evidence, the proposed fix, the decision, who decided and when. It also holds `owner` and `approver`, which stay empty on a personal vault. The log lives in the app data folder, one file per vault.

The fingerprint hashes the rule id, the target and the set of linking notes. An archived finding stays archived while its fingerprint is the same. New evidence brings it back to review, and the log says why.

### Past fixes to check

Fixes that ran before the current rules can be wrong. Quorum checks every finished fix against the current rules (`app/fixRecheck.js`).

- Old runs kept only their outcome and steps. Quorum reads the action, the note written and the note pointed at back from those lines, and the sources from the vault.
- A run is flagged when the rules now would not make its fix. The reasons are: fewer than two real sources, a session or eval folder, a name that exists as a folder, script, skill, repo file or branch note, a dropped confidential mark, a link fixed in a generated report, a relink or alias onto a stub an earlier fix wrote, onto a generated report or onto the linking note, and a match through a title that holds the note body.
- A flagged run shows in Needs review as "Past fix to check", with its reasons and evidence.
- Undo is offered only when Quorum can undo it. It tries, in order: the undo record; the note versions saved during the fix; the Trash for a note the fix wrote; an exact reversal of an alias or a relink, computed from the run's outcome. Each path refuses when a note changed after the fix. Undo checks the notes once more right before it writes.
- When Undo is not possible, the row says why and opens the note.
- Keep archives the item. Undo, Keep and Move back to review are logged in the decision log under the rule `fix.recheck`.
- Undo is never part of a bulk Approve.
- The check runs once per start. Results are kept in `fix-recheck.json` under the rule versions. A start with the same versions checks only new runs. A new rule version checks every run again.
- `app/scripts/fix-recheck-eval.mjs` runs the same check read-only against a vault and scores it against labels kept outside the repo.

### Cadence (Sprint 2)

- Rules run on a note when it is saved.
- An incremental sweep runs every 3 to 4 hours.
- A full sweep runs once a day while the Mac is idle.

### Earned auto-apply (Sprint 3)

Auto-apply is off for every rule. A rule can earn it from its own record:

- 30 or more decisions.
- 95% or more approved.
- No undo in the last 30 days.
- Its fix is reversible.

The person turns it on per rule in Settings. One in 20 auto-applied fixes still goes to review. An auto-applied fix is recorded with the decision `auto`.

## Team vault mode

A team vault is a workspace vault or a Team vault from [team-knowledge.md](team-knowledge.md). The same agent runs on it, with these additions.

### Note owners

Every note in a team vault has an owner. The owner is the member who wrote it or contributed it. An admin can change the owner. A note whose owner left the workspace goes to the workspace admins.

### Owner-routed approval

- A finding goes to the owner of each note its fix would change.
- A fix that changes notes with different owners needs every owner's approval before it runs.
- An admin can approve on behalf of an owner who left. The record says so.
- A member who owns none of the notes can see the finding only when they can read every note in its evidence.

### Permission-scoped evidence

- A finding never quotes or names a note its approver cannot read.
- When the evidence includes such a note, the finding counts it and says that a note the approver cannot open also links there.
- A fix never copies text from a note into a note with a wider audience. A note written from a Team note stays in that Team.
- Private notes and confidential notes never sync, so they are never evidence in a team vault.

### Attributed edits

- Every edit the agent makes in a team vault records who approved it and which rule proposed it.
- The edit syncs with that attribution. Teammates see it in the note's history.
- Undo records who undid it.

### Append-only audit log

- Each team vault has one audit log in Quorum Cloud.
- Records are only added. A record is never changed or removed.
- A record holds the decision log fields: rule id, rule version, fingerprint, evidence (as note ids the reader can resolve), proposed fix, decision, actor, owner, approver and time.
- Admins can export it.

### Rules restart in review per team

- Every rule starts in review on each team vault, whatever its record on a personal vault.
- A rule earns auto-apply per team vault, from that vault's decisions only.
- An admin turns auto-apply on for a team vault. An owner can turn it off for the notes they own.

### Sync through Quorum Cloud

- Findings run on the Mac of a member whose app is open. The first app to sweep after a change writes the findings.
- A finding syncs to Quorum Cloud as its fingerprint, rule, evidence ids, proposed fix and owners. Note text stays in the notes.
- Each member's app shows only the findings routed to them.
- A decision syncs back and is added to the audit log. The fix runs on the approver's Mac and syncs like any other edit.
- Two members who decide the same finding: the first decision wins, and the second sees it was decided.
- Offline decisions sync when the app is online again. A fix whose notes changed in the meantime is refused, as on a personal vault.

## Data fields

| Field | Where | Personal vault | Team vault |
|---|---|---|---|
| `ruleId`, `ruleVersion` | decision record | set | set |
| `fingerprint` | decision record | set | set |
| `owner` | decision record | empty | the note owner |
| `approver` | decision record | empty | the member who approved |
| `actor` | decision record | `you` or `quorum` | the member, or `quorum` |
| `undoneAt` | fix run | set on Undo | set on Undo |

## Open questions

- How long Quorum Cloud keeps the audit log on a workspace that stops paying.
- Whether an owner can delegate approval to a teammate.
