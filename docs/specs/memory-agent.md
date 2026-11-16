# Memory agent

Status: the local agent is built through Sprint 4 (past-fix re-check), Sprint 3A (bulk plans, corrective past fixes, confidential marks, Apply memory fixes on its own), Sprint 3B (agent-drafted fixes, near-duplicates, rule records, ignore rules) and the suggestion quality gate (the quality gate, the live precision guard, Retroactive improvements). Team vault mode is a spec only. Related: [team-knowledge.md](team-knowledge.md), [workspace-knowledge.md](workspace-knowledge.md), [research](../research/memory-agent.md).

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

Every finding has an Approve (`app/reviewApprove.js` approveFinding). It runs through the batch planner like any fix:

- Frontmatter: add each missing key, with the value Quorum can tell (the title, or a date in the file name) or an empty one.
- Stale: set `status: archived` only when the open note is both untouched for 90 days and past its due date. Any other stale note gets Mark it current: `last_verified` set to today (the local day). The rule (`note.stale`, version 2) then stops flagging the note until the folder's interval passes.
- Orphan: add a link line to the folder's index note (index, _index, README or the folder note), when there is one.
- Oversized, duplicates, secrets, and a confidential finding with no fix: keep as is.

An approved finding, and a past fix kept as is, move to Archived marked done (Accepted). A finding's new evidence brings it back to review.

The confidential rule (`note.confidential-folder`, version 2) offers fixes that run through the batch planner:

- Add the confidential tag: a note with no tag inside a folder marked confidential. This fix is automatic. An untagged note in a folder where most notes carry one value gets the same fix, approved by a person.
- Move: a note with a value outside every folder that holds that value moves to the main one.
- Move and tag: a note with no tag outside those folders whose links and embeds go mostly to notes with one value (three or more, and 60% or more of the notes it links) moves there and gets the tag.

A move updates the links that point at the note. Nothing moves until a person approves it.

### Confidential marks

A person marks a note or a folder confidential from the notes tree menu or the note view's More menu, and picks a value the vault already uses or a new one. A note mark writes `confidential: <value>` into its frontmatter. A folder mark is kept in Quorum's settings per vault and never written into the vault. Every note inside a marked folder counts as confidential for the read guard and the guardrails (while the built-in confidential rule is on) and for the confidential rule. The tree shows a lock on a marked folder and on a tagged note.

### Fix pipeline

1. A person approves one finding, or a selection of findings.
2. Approve on several items opens the bulk plan (below). A single link fix runs as its own run.
3. Each approved fix or plan becomes a run in one queue. Runs go one at a time.
4. The run records the hash of every note it will touch. It refuses to write a note whose text changed since the finding.
5. It refuses when the fix the finding gets now differs from the fix the person approved.
6. Before each write, the run saves the note's text in an undo record on disk.
7. After the write, Quorum checks the links of every touched note again. A fix that left a new broken link, a missing target or the same dead link is rolled back and marked Failed.
8. Each changed note gets a new version in its history (`app/memoryVersions.js`).

### Bulk plans (`app/batchPlan.js`, `app/reviewItems.js`)

Approve on several items in Memory health or Notifications opens a sheet at once with the loader "Building your bulk accept plan...". Review everything in Memory health plans the whole Needs review list the same way.

- The planner reads each item as a list of changes: put back, remove, add or take back an alias, relink, unlink, write a note, tag, move.
- It handles these conflicts: the same item twice or two items for the same target (the later one is skipped); two changes to the same line or frontmatter key (merged when both apply in one pass, held back otherwise); a note put back whole that another item changes (held back); a relink or alias onto a note another item removes or writes in the batch (skipped); an edit of a note another item removes (held back); an edit of a note another item moves (runs before the move).
- Corrective past fixes plan first, then link fixes, then finding fixes.
- The steps run in phases so each precondition holds: put back, remove, tag, alias, relink, unlink, write, move.
- The sheet lists groups with counts ("Remove 17 notes earlier fixes created", "Relink 9 links", "Tag 34 notes confidential", "Move 1 note") that fold open to their items and notes, then Merged, Skipped and Held back with a reason each. A group or an item can be unticked, and the plan is built again without it. Fixes a person should read first (a written missing note, a weak relink or alias, a move, move and tag, and a tag guessed from nearby notes) list under "Check these first" with a one-line reason per group. They start unticked, and the main process leaves them out of the batch unless the person ticks them.
- Apply runs the plan as one batch run: one journal, one undo record, the hash of every note checked before the first write, the links of every touched note checked after the last, and the whole batch put back when any step fails. Every changed note gets a version. Undo on the batch puts every note back. Cancel changes nothing.
- Review everything offers "Save as a note", off by default. Only that click writes a repair plan note into the vault.

### Apply memory fixes on its own

Settings > Memory has "Apply memory fixes on its own", off by default. When it is on, after each scheduled sweep (never after a save) every item with an automatic fix that the quality gate shows and the live precision guard has not demoted goes through the planner and the steps it can run apply as one batch with no review. Held back, conflicting and review-only items stay in Needs review. The batch shows in Notifications as one row with Undo. Each item is logged with the decision `auto` and the actor `auto`.

Automatic fixes: link fixes that are not review-only, corrective past fixes Quorum can undo exactly, and the confidential tag for a note in a marked folder.

### Run journal and recovery

Each run appends one line per step to a journal in the app data folder (`app/fixJournal.js`). A run still queued or running when Quorum quit is recovered on the next start. The notes it wrote go back from its undo record. A note the person edited since is left as it is. The run is marked Failed with a plain reason.

### Undo

Undo on a finished fix puts each note back and moves a note the fix wrote to the Trash. It refuses when any note changed after the fix, so later edits are never lost. The finding goes back to Needs review.

### Decision log

Approve, Archive, Undo and Move back to review each add a record (`app/decisionLog.js`). A record holds the rule id, rule version, a fingerprint of the finding, the evidence, the proposed fix, the decision, who decided and when. It also holds `owner` and `approver`, which stay empty on a personal vault. The log lives in the app data folder, one file per vault.

The fingerprint hashes the rule id, the target and the set of linking notes. An archived finding stays archived while its fingerprint is the same. New evidence brings it back to review, and the log says why.

The log keeps 5,000 records. Trimming drops the oldest records first and always keeps the latest record of every fingerprint, so an archived finding never comes back when its records grow old.

### Past fixes to check

Fixes that ran before the current rules can be wrong. Quorum checks every finished fix against the current rules (`app/fixRecheck.js`).

- Old runs kept only their outcome and steps. Quorum reads the action, the note written and the note pointed at back from those lines, and the sources from the vault.
- A run is flagged when the rules now would not make its fix. The reasons are: fewer than two real sources, a session or eval folder, a name that exists as a folder, script, skill, repo file or branch note, a dropped confidential mark, a link fixed in a generated report, a relink or alias onto a stub an earlier fix wrote, onto a generated report or onto the linking note, and a match through a title that holds the note body.
- A flagged run shows in Needs review as its corrective fix, with its reasons and evidence. Approve undoes the wrong change, sends the link back to review, and points it at the note the current rules pick when that fix is an alias or relink that needs no review of its own and is not onto a note Quorum wrote from links alone. It runs through the batch planner, alone or with other items.
- The undo part tries, in order: the undo record; the note versions saved during the fix; the Trash for a note the fix wrote; an exact reversal of an alias or a relink, computed from the run's outcome. Each path refuses when a note changed after the fix. The batch checks the notes once more right before it writes.
- When the undo is not possible (no undo record or saved version, a removed link, or a note changed after the fix), Approve does the first of these that applies, and the row's recommendation says which (`app/reviewApprove.js`):
  1. Restore from git history: the vault is in a git repo, and each note's text in the last commit before the fix differs from the note now only by the fix's change. Quorum puts that text back.
  2. Remove what the fix left: a note the fix wrote that still holds only what the fix wrote goes to the Trash, or the links a relink left pointing at a note that is gone lose their link and keep their words.
  3. A Retroactive improvement an agent drafted, when drafting is on and a second draft agreed (below).
  4. Keep as is: nothing changes, and the item leaves Needs review as done.
- Each path runs as a batch step, so it has a journal, versions and Undo, and bulk Approve plans it with the rest.
- Archive keeps the fix. Approve, Archive and Move back to review are logged in the decision log under the rule `fix.recheck`.
- The check runs once per start. Results are kept in `fix-recheck.json` under the rule versions. A start with the same versions checks only new runs. A new rule version checks every run again.
- `app/scripts/fix-recheck-eval.mjs` runs the same check read-only against a vault and scores it against labels kept outside the repo.

### Retroactive improvements

A past fix Quorum cannot undo exactly, or one that left a note worse, can still be improved (`reviewApprove.js` retroOf). Its item shows with the title "Retroactive improvement" and has its own group in the bulk plan ("Make 2 retroactive improvements to earlier fixes").

- A relink or alias that pointed links at the wrong note: the agent points them at the right note, chosen from the notes whose file names hold the link's words, or removes the links and keeps their words. An alias comes back off the wrong note first.
- A note an earlier fix wrote that now holds more than the stub: the agent rewrites it into a real note from its linking notes, with quotes, or removes it. The links then go back to review, where the current rules point them at a note when that is safe.
- An unlink has nothing to improve.

The agent drafts it like any other fix (`memoryDraft.js`, kind `retro`): its own sign-in, no tools, quotes checked character for character. The draft runs through the drafted fix slot of `approvePastFix` only after a second draft agreed. When drafting is off, the item says that turning on Let the agent draft fixes lets Quorum propose one, and Approve keeps the fix as it is.

### Quality gate (`app/qualityGate.js`)

Every item passes the gate before it shows in Needs review. The goal is that at least 90% of what Needs review shows is right, on any vault.

- Stability. The items are built twice: once, then again after the index re-scans and every note is read again. An item whose fix or note hashes differ between the passes waits. A drafted fix also needs a second, independent draft that agrees on the fix (the same kind onto the same note), with every quote of both drafts checked. A draft whose second draft disagrees is not offered.
- Fixability. An item whose only Approve is Keep as is shows only when it tells the person something they can act on: a secret, an exact duplicate, a confidential note in the wrong place, or a past fix the agent can improve. The rest is counted, not shown.
- Calibrated precision. Each kind of fix has a prior precision measured on Quorum's eval (`PRIORS`, with the count it rests on and its source): aliases 95%, strong relinks 92%, unlinks 95%, weak relinks and aliases 40%, writing a missing note 0%, the review rules 100% on their labeled items, past fixes Quorum can undo 95%, past fixes it cannot undo 90%. Agent drafts are unmeasured and start at 90% with little weight. This vault's decisions move it: expected precision is (p × n + approved) / (n + approved + archived + undone).
- Buckets. 90% or more: shown. 50% to 90% with a real fix: under Check these first in a bulk plan, unticked. Anything else: Not shown yet.
- Also not shown: a relink or alias onto a note Quorum wrote from links alone, and an item whose fix leaves the link as it is.

Memory health says how many suggestions are not shown yet, and the Not shown yet tab lists each with its reason. Notifications leaves them out. Review everything leaves out what is not shown; an item picked from Not shown yet can still run.

On a vault's first sweep, Needs review waits until the gate ran, and Memory health says "Checking your memory, this takes a minute". The verdicts are kept per vault in `memory-gate.json` with each item's signature, so a restart shows the list at once. An item whose fix or notes changed since waits for the next run, a few seconds later.

Each run adds a line to `memory-gate-log.jsonl` in the data folder: the passes, the counts, and each item's id, kind, bucket and reasons. `app/scripts/gate-report.mjs` prints shown against held per kind with the precision the decisions measure. `app/scripts/gate-eval.mjs` runs the gate read-only on a vault and scores the shown items against labels kept outside the repo.

### Agent activity (`app/agentActivity.js`)

Memory work that runs longer than 30 seconds shows as one state that Home and Memory health both read: the first memory check, a full sweep, a bulk batch, and a drafting run. The state holds the kind, a plain label, when it started, its progress and whether it can be cancelled. Home shows it as the AI working banner below the suggestion chips under the composer; clicking it opens Memory health, which shows the same banner. It hides when the work ends.

- The first memory check (a sweep, then both gate passes) runs in the background as soon as a vault is connected. Onboarding says so.
- Cancel stops a batch before its next step, and the batch puts back every note it wrote. It stops a check before the gate saves verdicts, and a draft by stopping the model call; that item is drafted again later.

### Live precision guard

For each kind of fix, once a person decided 10 or more items, Quorum compares approved with approved plus archived plus undone. Under 90%, the kind is demoted: its items move to Check these first (a real fix) or Not shown yet, and Apply memory fixes on its own never runs it. Settings > Memory shows "Demoted: 7 of 11 approved" on the rule. Each decision record keeps the kind of fix the gate scored (`proposedFix.gateKind`).

### Cadence (Sprint 2)

- Rules run on a note when it is saved.
- An incremental sweep runs every 3 to 4 hours.
- A full sweep runs once a day while the Mac is idle.

### Near-duplicates (`app/rules/nearDuplicates.js`)

The rule `note.near-duplicate` (version 1, review-only) finds two notes whose bodies share most of their text without being equal. Equal bodies stay with `note.duplicate`.

- Each body is read without its frontmatter, without heading lines that repeat in two or more notes of its folder, and without lines that repeat in three or more notes of its folder (template text). Wiki links count as their words.
- The rest becomes runs of three words. A MinHash signature of 32 values with 16 bands of 2 picks candidate pairs; each candidate is compared exactly by Jaccard similarity.
- A pair is a finding at a similarity of 0.5 or more. Bodies under 40 shingles are left out, and so are pairs between two folders that share five or more pairs (a mirror) and pairs of two notes named by their date (daily logs and recurring reports).
- The fix is "link these notes": a `Related: [[path]]` line in the first note. When the notes already link each other there is no automatic fix. With drafting on, the agent drafts a merge or a rewrite instead.

How the threshold was set: on a synthetic vault, copies with 2% to 5% of their words changed scored 0.58 to 0.86, copies with 10% scored 0.47 to 0.55, and unrelated notes scored 0.29 at most. Read-only on a real vault of 1,938 notes, 0.5 gives 55 pairs after the mirror filter and 16 after the dated-note filter. The first run takes about 0.85 s for 1,938 notes; later runs reuse each note's signature while its text and its folder's template lines are the same and take about 50 ms.

### Agent-drafted fixes (`app/memoryDraft.js`)

Settings > Memory has "Let the agent draft fixes", off by default. For the items the rules cannot decide, the agent drafts the fix:

- A missing note to write (a link fix whose action is write): the agent writes the note from the linking notes.
- A weak relink or alias (a review-only link fix): the agent says whether the links mean the note Quorum picked. When it says no, the item is held back with that reason.
- Two notes that repeat each other: the agent writes one merged note, or, when the notes disagree on a fact, rewrites the one that is out of date.

Rules for every draft:

- The model runs through the person's own Claude Code sign-in (`claude -p` with `--tools ''`, no API key). It has no tools; it reads only the numbered note text Quorum puts in the prompt and writes nothing.
- A note the read guard blocks is never sent. A note marked confidential (its frontmatter, the guardrails' keys, or a marked folder) is sent only when the person turns on "Let the agent read confidential notes". An item that needs a note the agent may not read gets no draft.
- Each draft carries quotes (note path, line number, text) and a confidence (high, medium, low). Quorum checks every quote against the line it names, character for character, and drops the draft when any quote fails. The draft is kept with a hash of its notes and dropped when a note changes.
- The draft shows in the row's details in Notifications and Memory health, and in the bulk plan. A drafted fix lists under "Check these first" unless its confidence is high and every quote checks. A drafted fix never applies on its own.
- Approve runs it through the batch planner and the journal like any fix. A merge writes the kept note (its own frontmatter, the merged body, and the other note's name added as an alias so its links keep working) and moves the other note to the Trash.
- At most 40 drafts a day by default (a setting). One draft runs at a time, once a minute at most, and never while a recording or a fix runs or while the person used the Mac in the last 2 minutes.
- The model call is injected, so tests run a fake model.

### Rule records and ignore rules (`app/ruleRecords.js`)

Settings > Memory lists each rule with its open findings and its decisions from the decision log: approved, archived, undone and applied on its own, with what it does now (review only, waits for review, or applies its automatic fixes on its own). The records are information. The one switch is "Apply memory fixes on its own" (Decisions from Eric, 2026-11-16).

When one rule's findings are archived three or more times (once per finding and evidence) with a shared folder, frontmatter key or target, Needs review shows one item proposing an ignore rule ("Stop flagging notes nothing links to in the folder drafts"). A folder or key proposal needs findings on two or more notes. Approve stores the rule in Quorum's settings per vault, never in the vault, and the rule's findings that match it stop showing. Archive turns the proposal down. Settings > Memory lists the ignore rules, each with Remove.

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
| `actor` | decision record | `you`, `quorum` or `auto` | the member, `quorum` or `auto` |
| `undoneAt` | fix run | set on Undo | set on Undo |

## Open questions

- How long Quorum Cloud keeps the audit log on a workspace that stops paying.
- Whether an owner can delegate approval to a teammate.
