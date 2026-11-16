# Memory agent

Status: the local agent is built through Sprint 4 (past-fix re-check), Sprint 3A (bulk plans, corrective past fixes, confidential marks, Apply memory fixes on its own), Sprint 3B (agent-drafted fixes, near-duplicates, rule records, ignore rules), the suggestion quality gate (the quality gate, the live precision guard, Retroactive improvements), contradiction detection and Approve does the work (one Needs review list; the agent fixes on Approve). Team vault mode is a spec only. Related: [team-knowledge.md](team-knowledge.md), [workspace-knowledge.md](workspace-knowledge.md), [research](../research/memory-agent.md).

The memory agent keeps a vault's links and notes in good shape. It finds problems, proposes a fix for each, and changes a note only after a person approves. Every fix can be traced and undone.

## Local agent

### Detectors

A detector is a rule with an id and a version. The version goes up when the fix a finding gets can change. Each decision records both, so a later version can tell which rule made a finding.

- `link.missing` (version 2, `app/linkRules.js`, `app/memoryHealth.js`). A link opens no note. The fix is one of: add an alias, point the links at an existing note, write the missing note, remove the link and keep its words, or leave it.
- Generated notes. Logs, reports and notes whose frontmatter marks them as generated are never a source of a missing link. Quorum never edits one to fix a link, and never points a link at one. Each rule in `GENERATED_RULES` names what it matches and why.
- Titles. A note's title is its frontmatter title or first heading, cut at a saved `\n` and at 120 characters.
- Existence check (`app/linkElsewhere.js`). Before Quorum offers to write a note, it looks for a folder, script, skill or repo file with that name, and for a note at that name on another local git branch. A folder with an index note gets a relink instead.
- Writing a note needs at least two linking notes a person wrote. It goes in the folder most of them sit in. It never goes in `memory/sessions` or `memory/eval`. It carries the confidential mark of its sources. Quorum writes it only from the agent's draft (Approve does the work, below); it never writes a note from links alone.

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
- The sheet lists groups with counts ("Remove 17 notes earlier fixes created", "Relink 9 links", "Tag 34 notes confidential", "Move 1 note") that fold open to their items and notes, then Merged, Skipped and Held back with a reason each. A group or an item can be unticked, and the plan is built again without it. Fixes a person should read first (a missing note the agent writes, a weak relink or alias the agent checks, a move, move and tag, a tag guessed from nearby notes, and every item the quality gate puts in its check bucket) list under "Check these first" with a one-line reason per group. They start unticked, and the main process leaves them out of the batch unless the person ticks them. A ticked item the agent fixes runs in the batch with the same agent work as a single Approve (below), one model call at a time, before the batch writes any note.
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
- Buckets. Every item shows in Needs review except one whose Approve could only keep it as it is and that tells the person nothing (bucket quiet, counted in the gate log). 90% or more: show, ticked in a bulk plan. Under 90%, an unstable fix, a draft no second draft confirmed, a demoted kind, a relink or alias onto a note Quorum wrote from links alone, and an item held for a reason: check, listed under Check these first in a bulk plan, unticked.
- The priors still decide the bulk default, what Apply memory fixes on its own may run, and the live precision guard.

There is one Needs review list. Memory health has no separate tab for held items. Notifications and Review everything leave out only the quiet bucket.

On a vault's first sweep, Needs review waits until the gate ran, and Memory health says "Checking your memory, this takes a minute". The verdicts are kept per vault in `memory-gate.json` with each item's signature, so a restart shows the list at once. An item whose fix or notes changed since waits for the next run, a few seconds later.

Each run adds a line to `memory-gate-log.jsonl` in the data folder: the passes, the counts, and each item's id, kind, bucket and reasons. `app/scripts/gate-report.mjs` prints shown against held per kind with the precision the decisions measure. `app/scripts/gate-eval.mjs` runs the gate read-only on a vault and scores the shown items against labels kept outside the repo.

### Agent activity (`app/agentActivity.js`)

Memory work that runs longer than 30 seconds shows as one state that Home and Memory health both read: the first memory check, a full sweep, a bulk batch, and a drafting run. The state holds the kind, a plain label, when it started, its progress and whether it can be cancelled. Home shows it as the AI working banner below the suggestion chips under the composer; clicking it opens Memory health, which shows the same banner. It hides when the work ends.

- The first memory check (a sweep, then both gate passes) runs in the background as soon as a vault is connected. Onboarding says so.
- Cancel stops a batch before its next step, and the batch puts back every note it wrote. It stops a check before the gate saves verdicts; when that was a vault's first check, Memory health says it stopped and Check again runs it. It stops a draft by stopping the model call; the call does not count against the daily cap, and that item is drafted again later.

### Live precision guard

For each kind of fix, Quorum reads the last 50 decisions a person made (approved, archived, undone) and compares approved with all of them. With 10 or more decisions in that window and under 90% approved, the kind is demoted: its items list unticked under Check these first, and Apply memory fixes on its own never runs it. The demotion lifts once the window is back at 90% or above, so an early run of dismissals does not hold a kind down after the person approves its newer fixes. Until a kind has 10 decisions, its eval prior decides. Settings > Memory shows "Demoted: 7 of the last 11 approved" on the rule. Each decision record keeps the kind of fix the gate scored (`proposedFix.gateKind`).

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

### Contradictions (`app/rules/contradictions.js`)

The rule `note.contradiction` (version 1) finds two notes that make claims about the same subject and attribute that cannot both hold. It follows the design in the contradiction research note, in five stages:

1. Index (`app/contradictionIndex.js`, no model). It decides which notes the agent reads: a note with a decision phrase, a date (frontmatter, file name or body), a status field or a superseded marker, or a decision record, and a note that links to one of those. Notes with none of these are never sent. Frontmatter keys, decision phrases ("we decided", "agreed to", "final decision"), dates, the status field, superseded markers ("superseded by", "replaced by", `status: superseded`, `superseded_by`, "This replaces [[note]]") and wiki links, cached by the hash of each note's text. Each note gets an authority rank: decision record (`type: decision` or a `decisions` folder) 1, project or reference note 2, meeting note 3, session log 4, inbox note 5. A note's date comes from its frontmatter (`decided`, `date`, `created`) or its file name, never its modified time.
2. Claims (`app/contradictionClaims.js`). Without a model: frontmatter keys and "key: value" body lines, with a leading wiki link as the subject (`- [[Atlas]] status: paused`). With Let the agent draft fixes on: the agent reads several notes per call through the person's own Claude Code sign-in, with no tools, and answers strict JSON with each claim tagged by its note's path. A call packs notes in priority order (decision records, then notes with decision phrases, then dated notes, then linked notes) up to about 12k input tokens (44,000 characters, at most 20 notes, each note cut at 12,000 characters). Each claim holds subject, attribute, value, polarity, modality, date, scope, authority, the verbatim quote and its line range. Quorum checks every quote against the lines of the note its path names and drops a claim whose quote does not match or whose path names another note, and a date the quoted lines do not hold. Claims are kept per note hash in the app data folder (`memory-contradictions.json`).
3. Pairs (`app/contradictionPairs.js`, no model). Subjects map to notes through titles, aliases, file names and wiki link targets, then acronyms, then string similarity (0.86). Attributes join clusters through a synonym table (price, owner, status, deadline, launch, database, hosting, team size, plan) and string similarity (0.8). Claims in two notes pair when the subject and attribute cluster match and the value or polarity differs. Each pair records how it matched: exact, alias, acronym or fuzzy.
4. Resolve (`app/contradictionResolve.js`). Symbolic rules first: R1 an explicit marker closes the pair; R4 different scopes close it; R2 a dated newer decision of equal or higher authority adds a superseded marker; R3 dated plain statements add "as of DATE"; R5 a refinement suggests a link; R6 a newer claim with less authority, or one only proposed, asks a person; R7 a pair with a missing or equal date asks a person. Only pairs of agent claims go to the judge, which answers contradiction, refinement, different times, different scope or same, with a quote from each note that Quorum checks. Other notes on the same point list with the item (R8) and are never fixed on their own.
5. Fix. The fix only adds text to the end of the older claim's line: ` (superseded by [[newer]] on DATE)` or ` (as of DATE)`. A claim in frontmatter gets no fix. The `annotate` step refuses when the line changed since the plan, and the batch undo record puts the line back.

Items show both quotes with their note, line and date. They go through the batch planner and the decision log like any finding. An item applies on its own only when all of these hold: both quotes match the file now; subject and attribute matched by exact key or alias; both dates come from text or frontmatter; the newer side is a decision of equal or higher authority; the scopes are the same or both empty; the rule is R1, R2 or R3; the fix only adds text and the batch undo reverses it; neither note is confidential and the subject is not a person, money, legal or health topic; and the rule's measured precision meets the bar. The bar is read from the decision log over items in that slice: 150 or more decisions, 98% approved or applied without undo, a 95% Wilson lower bound above 95%, and fewer than 2 undos in the last 50 automatic applications. Until then every fix lists under "Check these first". Items also pass the quality gate (`app/qualityGate.js`) as the kind `finding:note.contradiction`, with an unmeasured prior of 70%: a fix waits under Check these first, and an item with no fix (R6, R7) shows in Needs review, where Approve keeps both notes and marks it done. This vault's decisions move the kind as with any other kind, and the live guard can demote it.

The agent's calls share the drafter's daily cap and wait the same way. A draft goes first; claim extraction and judging take the minute only when the drafter has nothing to do, and only one model call runs at a time. A call that runs past 30 seconds shows in Agent activity on Home ("The agent is reading 12 notes for decisions that disagree", "The agent is checking two notes that may disagree") with Cancel, which stops the model call, gives its place under the daily cap back, and leaves the notes to be asked for again on the next sweep. A note the read guard blocks or a note marked confidential is never sent (the same gate as drafts). With drafting off, the rule reads structured claims only.

### Check everything now

A first full pass over a vault normally runs under the daily cap: on a vault of 2,000 notes, about a week at 40 calls a day. Check everything now (`app/memoryCatchup.js`) lifts the cap for one full pass only. It runs every pending draft and claim batch, then the pairs to judge those claims bring, one model call at a time, with the same timeouts, the read guard and the confidential gates. It does not wait for the person to stop typing, and it waits while a recording or a fix runs. Its calls do not count against the daily cap, so once the pass is done the normal cap applies again. It writes nothing to the vault; what it finds waits in Needs review.

The pass shows at once in the agent activity banner on Home and in Memory health ("Checking all 1,940 notes: 12 of 261 calls"). Cancel stops the call that runs; that call is not counted, and everything left runs later under the normal cap.

The pass needs Let the agent draft fixes; starting it turns that on and says so. It starts from:

- Onboarding, once the vault connects: "Check my whole memory now", on by default, with the estimate ("This uses your Claude plan for about N calls and runs in the background."). The pass starts when the person opens Quorum, after the model step.
- Settings > Memory: Check everything now, with the same estimate, off while a pass runs.
- A script, for an existing install: `node scripts/memory-catchup.mjs [estimate|start|status|cancel] [--dev]` asks the running app over its control socket.

The estimate is stage 1's notes to read that have no stored claims for their text now, packed into claim calls (`packBatches`), plus two calls for each item that waits for a draft and one for each draft that waits for its second. Judge calls are counted as the pass finds pairs.

`app/scripts/contradiction-eval.mjs` runs stages 1, 3 and the symbolic part of 4 read-only against a vault with no model call and prints counts, and scores against contradiction labels kept outside the repo. It also packs the notes stage 1 sends into calls and prints how many calls and days the first pass takes. On a real vault of 1,940 notes, stage 1 sends 1,641 notes plus 66 linked ones: 261 calls (about 2.4M input tokens), 7 days at 40 calls a day before judge calls. The same vault reads 25,071 structured claims and makes no candidate pair, so the no-model path adds no items there; the first run takes about 0.7 s and later runs about 80 ms. The synthetic fixture (`app/test/fixtures/contradictions`) covers true contradictions, different times, a scope split, a refinement, the same fact in other words, an explicit marker, an authority inversion, an undated pair, a confidential note and a quote that does not match.

### Approve does the work (`main.js` agentNeed, agentResolve)

Approve on an item the rules cannot decide does the whole job as one task. It runs whether or not Let the agent draft fixes is on, since the person asked for it. It still honors the read guard, the confidential gates and the daily cap, and runs through the person's own Claude Code sign-in (`memoryDraft.js` onDemand).

- A missing note to write: the agent drafts the note from the notes that link to it, with every quote checked against its note. Quorum picks the folder by the rules above, carries the confidential mark of the sources, and writes it through the journal (versions, Undo).
- A weak relink or alias, or one onto a note Quorum wrote from links alone: the agent checks the match against the note Quorum picked and up to three notes whose file names hold the link's words. Quorum points the links at the note it confirms, or at a better one, or removes the dead link and keeps its words when no note fits. When no other note has a close name, Approve removes the dead link with no model call.
- A contradiction with no fix ("ask a person"): Approve keeps both notes and marks the item done. A contradiction with a fix applies it.
- Any other item: Approve runs its own fix through the same path.

Each row's recommendation says what Approve does, in plain words ("Quorum writes a note about “Kite” from the 3 notes that link to it"). Approve runs as a batch whose first step is the agent's work. While it runs, the row shows it working, and after 30 seconds Home and Memory health show the agent activity banner. Cancel stops the model call, which does not count against the daily cap.

When the agent cannot produce a fix that passes its checks (a quote that does not match its note, low confidence, a note it may not read), Quorum writes nothing. The run fails with the reason, and the item stays in Needs review with its reason and the safe fallback: Approve then removes the dead link and keeps its words. The fallback holds until a note the agent read changes. A daily cap that is used up or a model that cannot run leaves the item as it was.

The decision log records an item the agent fixed once the agent drafted it, with the kind of fix it drafted, so the live precision guard measures the agent's fixes.

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
