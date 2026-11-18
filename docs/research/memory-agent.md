# Quorum Memory Agent Research

Scope: how an agent can keep a local markdown "Agent OS" vault correct and useful over time, then extend the same agent to shared team knowledge bases. Quorum already ships "Memory health" for broken wiki links and missing aliases (detect, list as Needs review, Approve runs an agent fix, file version saved, Undo). This doc covers what to add next.

Method: web research on 2026-11-15 (Tavily search, Firecrawl scrape). Source URLs are inline. Claims marked "(unverified)" came from secondary sources only.

## 1. Issue taxonomy

A vault is healthy for an agent when three things hold. The agent can find the right note from the index and links. The facts it reads are current and do not contradict each other. Nothing it reads is in a place the user did not intend (wrong folder, wrong confidentiality area).

Detection tiers used below:

- **Rule**: deterministic code. No model call. Cheap, repeatable, testable.
- **Embed**: embedding or hash similarity. Local or cheap. Produces candidates only.
- **Judge**: an LLM decides. Costs tokens. Needs evidence and calibration.

| Issue | Detect | Fix action | Main false-positive trap |
|---|---|---|---|
| Broken wiki link | Rule | Retarget to the closest existing note, add alias, or create stub | Links inside code blocks; links to notes the user plans to write |
| Missing alias | Rule + Embed | Add `aliases:` entry | Two different notes that share a short name |
| Orphan note | Rule (zero backlinks) | Suggest 1 to 3 links from related notes, or move to archive | Entry points (index, inbox, daily notes) are orphans by design |
| Missing or invalid frontmatter | Rule (schema per folder) | Insert required keys with inferred values | Folders with no schema; templates |
| Wrong folder | Rule (frontmatter type vs folder) then Judge | Propose a move and rewrite inbound links | Notes that are legitimately cross-cutting |
| Exact duplicate | Rule (content hash) | Merge, keep the older path, redirect links | Template stubs that are identical on purpose |
| Near duplicate | Embed (MinHash or cosine) then Judge | Merge proposal with a side-by-side diff | Shared boilerplate (meeting templates) inflates similarity |
| Contradiction | Embed (candidate pairs) then Judge | Mark one claim superseded with a date, keep both in history | Claims that were true at different times; claims scoped to different projects |
| Outdated fact or status | Rule (date math, `status:` vs last activity) then Judge | Update the status, add "as of" date, or flag for the user | Planned future dates; deliberately frozen historical notes |
| Stale note | Rule (age, no edits, no reads, no backlinks) | Ask the owner to re-verify or archive | Age alone over-reports. A correct old note is still correct |
| Oversized note | Rule (token count, heading count) | Propose a split by H2 with links back | Reference docs that are long on purpose |
| Low-signal note | Rule (length, empty body) then Judge | Merge into a parent note or archive | Short notes that are deliberate stubs or tasks |
| Confidential content in wrong area | Rule (secret regex, entropy, PII recognizers, frontmatter tag vs folder) then Judge | Move to the restricted area, redact, or flag | Fake fixture keys, example emails, public names |

Detail on the harder rows:

- **Orphans and broken links.** The Obsidian plugin "Find orphaned files and broken links" uses ignore lists for files, folders and tags because entry-point notes are orphans by design ([find-unlinked-files](https://github.com/Vinzent03/find-unlinked-files)). Vault Inspector 0.4.14 removes only the exact wiki-link token, ignores links inside code and comments, re-checks each fix before it runs, and leaves unsafe Markdown links report-only ([Obsidian forum](https://forum.obsidian.md/t/vault-inspector-find-broken-links-and-orphan-attachments/114637)). Quorum should copy those three safety rules.
- **Frontmatter.** Obsidian Linter has deterministic YAML rules such as `insert-yaml-attributes`, `yaml-timestamp`, `yaml-title-alias`, `dedupe-yaml-array-values` ([obsidian-linter](https://github.com/platers/obsidian-linter)). These need no model.
- **Near duplicates.** A measured benchmark found MinHash with 128 permutations and LSH banding recovered 99.47% of near-duplicate pairs in 100,000 documents with no false positives. The same write-up shows that shared boilerplate breaks fixed thresholds: at 45% boilerplate a 0.30 threshold returned about 114 false positives per true pair. The fix is to sample known-unrelated documents and set the threshold above their 99th percentile ([cstsolution](https://cstsolution.com/blog/deduplicating-documents)). For Quorum: strip template headings and frontmatter before hashing meeting notes.
- **Contradictions.** Pure LLM judges have high false-positive rates on consistency checks. One study measured up to 63.7% false positives for GPT-3.5 ([ACL Findings 2024](https://aclanthology.org/2024.findings-emnlp.596.pdf)). LegalWiz found NLI has high recall and low precision, LLM judges have better context but lower coverage, and a hybrid of the two scored best (F1 89.5%) ([arXiv 2510.03418](https://arxiv.org/html/2510.03418v2)). The same paper reports cross-document contradiction detection is still hard. For Quorum: only judge pairs that embedding similarity already linked, require the judge to quote both conflicting sentences, and treat "true at different times" as a separate outcome (supersede, keep history).
- **Stale notes.** A Confluence admin thread notes that age alone over-reports, and recommends two better signals: the owner has left, and a duplicate exists ([Atlassian community](https://community.atlassian.com/forums/discussion/3287652/finding-old-outdated-pages-in-a-confluence-space)). Stale Content Auditor counts freshness from the last edit or the last recorded review, whichever is newer, so a reviewed page stays fresh without edits ([Atlassian Marketplace](https://marketplace.atlassian.com/apps/1040161133/stale-content-auditor-for-confluence)). Quorum should store a `last_verified` date per note and use it the same way.
- **Confidential content.** Gitleaks combines regex rules, a Shannon entropy threshold (often about 3.5 bits per character) and allowlists for fixtures ([gitleaks](https://github.com/gitleaks/gitleaks), [Starlog](https://starlog.is/articles/cybersecurity/gitleaks-gitleaks)). Presidio uses regex plus NER recognizers with a 0 to 1 score. Guidance is a high threshold (0.7+) for automated action and 0.3 to 0.5 for human review queues ([dev.to](https://dev.to/bspann/detecting-pii-in-real-world-text-310p), [Presidio FAQ](https://github.com/data-privacy-stack/presidio/blob/main/docs/faq.md)). For Quorum, the strongest signal is structural: a note tagged `confidential: <value>` sitting outside the folder that holds the other notes with that value, or a note in a restricted folder linked from a shared note.

## 2. Prior art

### Agent memory systems

- **Letta sleep-time compute.** A second agent runs in the background while the primary agent is idle. It consolidates, summarizes and invalidates archival records. Because it is off the latency path, it can use a slower and stronger model ([Letta lesson notes](https://ai-engineering.academy/learn/14-agent-engineering/08-memory-blocks-sleep-time-compute)). The research paper reports about 5x lower test-time compute at equal accuracy and up to 18% accuracy gains (arXiv 2504.13171, via [MindPattern](https://mindpattern.ai/e/letta-sleep-time-compute); numbers unverified against the paper).
- **Mem0.** For each candidate fact, retrieve similar stored memories and let the LLM pick one of four operations: ADD, UPDATE, DELETE, NOOP ([arXiv 2504.19413](https://arxiv.org/html/2504.19413v1)). Community prompts order the checks NOOP, DELETE, UPDATE, ADD so the default is "do nothing" ([Medium](https://medium.com/@kunalkushwahatg/mem0-bd7467fef9ba)). Lesson for Quorum: a fixed, small operation set is easier to audit and to learn acceptance rates for.
- **Zep / Graphiti.** Each fact edge carries `created_at`, `valid_at`, `invalid_at`, `expired_at` ([Zep docs](https://help.getzep.com/facts)). When a new edge contradicts an old one, Graphiti sets the old edge's `invalid_at` to the new edge's `valid_at` and keeps it ([arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)). It also rewrites the old fact into past tense, for example "Maria used to work as a junior manager, until her promotion" ([Zep blog](https://www.getzep.com/blog/beyond-static-knowledge-graphs)). Lesson: resolve contradictions by superseding with dates. Deleting loses history.
- **A-MEM.** Each new memory gets keywords, tags and a context description. The system links it to similar older memories and may update those older memories ("memory evolution") ([arXiv 2502.12110](https://arxiv.org/abs/2502.12110)). Ablations show both linking and evolution help. A critique notes there is no pruning step, so stale links accumulate ([MemoryLake](https://www.memorylake.ai/ko/blogs/a-mem-zettelkasten)). Lesson: auto-linking needs a matching unlink pass.
- **LangMem.** Splits memory work into hot-path tools the agent calls during a conversation and a background memory manager that extracts and consolidates later ([LangMem](https://github.com/langchain-ai/langmem), [background quickstart](https://langchain-ai.github.io/langmem/background_quickstart)).

### Anthropic guidance

- **"The components of agent memory" (2026-11-06).** Describes "dreaming": using idle compute to check notes against original transcripts, merge duplicates, correct mistakes and maintain navigation structures ([Anthropic](https://www.anthropic.com/research/components-of-agent-memory)). Two points matter for Quorum. First, the transcript is the ground truth to check notes against; Quorum has meeting transcripts for every meeting note. Second, the article says checking every memory continuously "might not be practical" and suggests focusing on information likely to change, or tuning cadence by how often memories are accessed. It also reports Claude marking facts as checked versus unconfirmed.
- **Claude Code auto memory.** `MEMORY.md` is an index. Only the first 200 lines or 25 KB load at session start ([Claude Code docs](https://code.claude.com/docs/en/memory)). An index that grows past that limit silently hides content, which is a concrete health rule Quorum can check.
- **Auto Dream.** Secondary sources describe a Claude Code background pass that runs after 24 hours and 5+ sessions, dedupes entries, converts relative dates to absolute, removes contradicted facts and keeps `MEMORY.md` under 200 lines, in four phases (orient, gather signal from transcripts, consolidate, prune and index) ([claudefa.st](https://claudefa.st/blog/guide/mechanics/auto-dream), [zenvanriel](https://zenvanriel.com/ai-engineer-blog/claude-code-autodream-memory-consolidation-guide)). Unverified against first-party Anthropic docs.

### Vault and wiki tooling

- **Karpathy LLM wiki.** Three layers: raw sources the model never edits, a wiki the model owns, and a schema file. Three operations: ingest, query, lint. Lint checks contradictions, stale claims superseded by newer sources, orphan pages, concepts without a page and missing links; it reports, fixes only what the user approves, then logs the pass ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), [Sentra summary](https://www.sentra.app/articles/karpathy-llm-wiki)). A known failure mode: if an ingest bakes in a wrong claim and propagates it, lint finds no contradiction because the pages agree ([Extended Brain](https://extendedbrain.substack.com/p/the-wiki-that-thinks-ingest-lint)). Lesson: check claims against sources (transcripts), in addition to checking notes against each other.
- **Obsidian Linter** and **Find orphaned files**: see section 1.

### Team knowledge base prior art

- **Guru.** Each card has a named verifier (person or group) and a verification interval (30, 60, 90 days, 6 months, 1 year, or never). If a non-verifier edits a card, it becomes unverified and a verification request goes out. Any reader can unverify a card to request review ([Guru help](https://help.getguru.com/docs/verifying-and-unverifying-cards)). Unverified, unused cards queue for archive review ([Rework comparison](https://resources.rework.com/tools/productivity/glean-vs-guru)).
- **Notion.** Verified pages need at least one owner. Verification is time-boxed or indefinite. On expiry the owner gets an inbox notification and email ([Notion help](https://www.notion.com/help/wikis-and-verified-pages)). Expired pages lose priority in search and AI answers ([Matthias Frank](https://matthiasfrank.de/en/notion-page-verification); secondary source).
- **Confluence.** Native archive removes pages from the tree and quick search, shows an archived banner, supports restore, and lets the archiver add a reason note ([Atlassian support](https://support.atlassian.com/confluence-cloud/docs/archive-pages)). Marketplace apps add owners, Fresh/Aging/Stale buckets and a who-and-when review log.
- **Glean.** Answers from source systems as they are. Per the Rework comparison, Glean has no built-in re-verification cycle; freshness depends on the source document ([Rework](https://resources.rework.com/tools/productivity/glean-vs-guru)).
- **Wikipedia bot policy.** Bots get approved per task. A trial of 10 to 100 edits or 3 to 7 days comes first, with a human reviewing every edit. Large tasks use ramp-up trials with paced edit counts ([Bot policy](https://en.wikipedia.org/wiki/Wikipedia:Bot_policy), [BAG guide](https://en.wikipedia.org/wiki/Wikipedia:Bot_Approvals_Group/Guide)). This is the closest prior art for earning auto-approve per rule.

## 3. Self-improvement loops

Quorum already gets a labeled data point on every Approve, Archive and Undo. Use them as follows.

1. **Log every decision as a record.** Fields: rule id, rule version, detector tier, judge model, judge confidence, evidence quoted, note path, folder, user decision (approve, archive, edit-then-approve, undo), time to decision, and whether the user edited the note again within 7 days.
2. **Per-rule acceptance rate.** Track approve rate, undo rate and edit rate per rule and per folder. A rule with near-100% approvals and no undos is a candidate for auto-apply. A rule with frequent edits needs a better fix prompt ([Lumay](https://www.lumay.ai/blogs/human-in-the-loop-ai-agents-approval-design)).
3. **Earned autonomy per rule.** Use three tiers: auto-apply, review, block ([Thinking Loop](https://medium.com/@ThinkingLoop/human-in-the-loop-ai-without-the-slowdown-e2ea019587f4)). Promote one rule at a time after a trial, as Wikipedia does for bots. A practical gate: at least 30 decisions on that rule, approve rate at least 95%, zero undos in the last 20, and the fix is reversible. One HITL guide cites about a 5% error threshold for graduating an action ([Pickaxe](https://pickaxe.co/post/human-in-the-loop-ai-agents)). After promotion, sample a small share of auto-applied fixes back into Needs review to check the threshold still holds ([Dataiku](https://www.dataiku.com/blog/human-in-the-loop-ai-agents)).
4. **Archive as a suppression signal.** When the user archives a finding, store a fingerprint (rule id + note path + content hash of the matched span) so the same finding does not return. Gitleaks fingerprints findings for the same reason ([gitleaks](https://github.com/gitleaks/gitleaks)). If several archives share a pattern (same folder, same tag), propose an ignore rule to the user rather than learning it silently.
5. **Do not trust verbalized confidence.** LLM judges are overconfident. Verbalized confidence around 0.85 to 0.95 has been reported on questions answered correctly 60 to 70% of the time ([FutureAGI](https://futureagi.com/blog/evaluating-llm-confidence-uncertainty-2026), [arXiv 2508.06225](https://arxiv.org/html/2508.06225v2)). Calibrate instead: build a labeled eval set from past decisions, measure accuracy per confidence bucket, and set auto-apply thresholds from measured accuracy. Re-run the eval when the judge model or prompt changes.
6. **Evidence is mandatory.** Every Judge finding must quote the exact sentences (and, for meeting notes, the transcript span) that support it. A finding without a verifiable quote goes to review or is dropped. A string-match check that the quote exists in the file is a cheap rule that blocks hallucinated evidence.
7. **Watch the reviewer.** Faster approvals with fewer edits can mean the user stopped reading ([Pickaxe](https://pickaxe.co/post/human-in-the-loop-ai-agents)). Cap Needs review at a small daily batch, ranked by impact, so review stays real.

## 4. Self-heal

The agent should repair its own failures with the same care it applies to notes.

- **Write-ahead run journal.** Before a fix writes, record run id, target paths, pre-write content hash and the planned diff. Mark the run done after the write and the version save both succeed. On startup, any run without a done marker is interrupted: compare current hashes to pre-write hashes, then either complete, roll back from the saved version, or surface it as "Fix interrupted" for the user.
- **Optimistic concurrency against user edits.** A finding stores the content hash of the note when it was detected. On Approve, re-hash. If the note changed, re-run detection on the new content before applying (Vault Inspector re-checks each fix before it runs). If the finding no longer holds, close it silently.
- **Undo after later edits.** If the user edited the note after a fix, Undo must not overwrite their edit. Revert only the fix's hunks (three-way: pre-fix, post-fix, current). If hunks conflict, show both versions and ask.
- **Post-fix verification.** After each fix, re-run the rule that produced it on the changed files and on files that link to them. A fix that leaves the rule still firing, or creates a new broken link, auto-rolls back and lowers that rule's tier.
- **Index drift.** Keep a manifest of path, mtime, size and content hash. Each sweep compares the manifest to disk to find files changed outside Quorum (Obsidian, git pull, iCloud). A daily full rebuild of the link graph and the embedding index, compared to the incremental state, measures drift; any mismatch is logged and repaired from disk, which stays the source of truth.
- **Failure budget.** If a rule's fix fails N times in a row, pause that rule and show one health item ("Alias fixer paused after 3 failures") instead of N failed findings.
- **Self-audit of agent writes.** Tag every agent-written file version with run id and rule id, so a bad rule version can be rolled back across all notes it touched in one action.

## 5. Cadence and cost

**What needs no LLM.** Broken links, missing aliases (candidate generation), orphans, frontmatter schema, exact duplicates, near-duplicate candidates (MinHash locally), oversized notes, empty notes, date and status rules, secret and PII regex, confidentiality tag versus folder, `MEMORY.md` or index length limits, manifest drift. These can run on every file save or every sweep at near-zero cost.

**What needs an embedding model.** Near-duplicate and contradiction candidate pairs, alias suggestions, link suggestions for orphans. A local sentence-embedding model on the Mac avoids per-token cost. Re-embed only changed files.

**What needs an LLM judge.** Contradictions, outdated facts that need reading comprehension, wrong-folder judgments, merge proposals, split proposals, low-signal judgments, and writing the actual fix.

**Schedule.**

- On save or on meeting note write: Rule checks for that file only.
- Every 3 to 4 hours: incremental sweep of files changed since the last sweep (manifest diff), plus their direct link neighbors. Rule + Embed on all of them; Judge only on candidates.
- Daily, while the Mac is idle and on power: full Rule sweep, index rebuild and drift check, Judge pass on the oldest-verified notes in folders likely to change (project folders, notes with status fields). This follows Anthropic's advice to focus checks on information likely to change.
- Weekly: full near-duplicate and contradiction candidate scan across the vault, Judge on top candidates only.

**Token estimate.** Assumptions (not measured on a real vault): 2,500 notes, average 1,500 tokens each, so about 3.75M tokens for one full read. Current list prices: Haiku 5.5 from $0.10 / $0.50 per million input / output tokens, Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20; Batch API is 50% off; cache reads are 10% of input on most models and 5% on Opus 5.5 and Sonnet 5.5 ([Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview.md)).

| Job | Tokens in | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|---|
| Full read of every note, short verdict out (~100 tok each) | 3.75M in, 0.25M out | about $0.50 | about $10 |
| Weekly contradiction pass, 500 candidate pairs at ~3,500 tok each, 200 tok out | 1.75M in, 0.1M out | about $0.23 | about $4.50 |
| Incremental sweep, 20 changed notes/day, each with 5 neighbors | ~0.18M in/day | about $0.02/day | about $0.40/day |

Notes on the table. These are API-dollar equivalents. Quorum answers through the user's own Claude Code sign-in, so the real cost is the user's plan usage and rate limits. The exact plan limits were not verified. The practical rule is the same either way: keep Judge calls to filtered candidates, cap per-sweep calls, and back off when the user is active. A cheap model screens; a stronger model writes fixes and judges contradictions. Haiku 5.5 pricing says "from", so the real rate may be higher at some tiers.

## 6. Team vault differences

- **Owners per note or folder.** Every shared note needs an owner field (person or group). Guru and Notion both require it for verification. Findings route to the owner. Notes with no owner, or with an owner who left, are themselves a finding.
- **Who approves.** Single-user: the user. Team: the note owner approves content fixes (merge, contradiction, outdated fact). Structural fixes (broken link, alias, frontmatter key) can be approved by any editor, or auto-applied after the rule earns it. Moves across permission boundaries need an admin.
- **Permissions.** The agent acts with the permissions of the person who approves, and never with more. It must not read a restricted note to judge a shared one unless every viewer of the output can see the source. A contradiction finding between a private note and a shared note must not reveal the private sentence to the shared note's owner.
- **Attribution.** Every agent edit is attributed as "Quorum agent, approved by X", with rule id and run id. Wikipedia flags bot accounts for the same reason ([Bot policy](https://en.wikipedia.org/wiki/Wikipedia:Bot_policy)).
- **Notify owners.** Batch notifications per owner per day. Use verification expiry in the Guru and Notion style: when `last_verified` passes the interval, the owner gets one request. A non-owner edit resets verification, as in Guru.
- **Conflicts.** Multiple editors raise the rate of "note changed since detection". The hash check in section 4 becomes mandatory. Fixes should be small hunks so they merge cleanly. Two editors approving conflicting fixes on the same note: the second approval re-runs detection.
- **Audit trail.** Keep an append-only log: finding, evidence, approver, decision, applied diff, undo. Confluence archive notes and the Stale Content Auditor review log are the reference shape. Retain it per workspace policy.
- **Pace.** Team vaults should start every rule in review mode, even rules auto-applied in the user's personal vault, and earn auto-apply again per workspace.

## Recommendations for Quorum

Ranked by value per unit of risk. Each item lists detection method and risk.

1. **Finding record + decision log for every Approve, Archive, Undo.** Detection: n/a (infrastructure). Risk: low. Everything in section 3 depends on it.
2. **Hash check before apply, and hunk-level Undo.** Detection: Rule. Risk: low. Prevents overwriting user edits made after detection, and is required for team vaults.
3. **Run journal with interrupted-run recovery and post-fix re-check.** Detection: Rule. Risk: low. Covers the self-heal cases with no model calls.
4. **Expand Rule checks: orphans (with entry-point allowlist), frontmatter schema per folder, exact duplicates, oversized notes, index length limit, confidentiality tag versus folder, secret regex + entropy.** Detection: Rule. Risk: low for detection; fixes for confidentiality should stay review-only.
5. **Per-rule earned auto-apply.** Detection: decision log statistics (30+ decisions, 95%+ approve, no recent undos, reversible fix), plus 5% sampled back to review. Risk: medium. Start with alias and broken-link retarget only.
6. **Archive fingerprints to suppress repeat findings, and ignore-rule proposals.** Detection: Rule (fingerprint match). Risk: low. Stops the same rejected finding from returning.
7. **Near-duplicate detection with template stripping and a measured threshold.** Detection: Embed (local MinHash or embeddings), then Judge for the merge proposal. Risk: medium. Merges change content; always review, never auto-apply.
8. **Transcript-grounded fact check for meeting-derived notes.** Detection: Judge, comparing note claims to the source transcript with required quotes. Risk: medium. This follows Anthropic's dreaming guidance and covers the failure mode that note-to-note lint misses.
9. **Supersede-with-date contradiction resolution.** Detection: Embed for candidate pairs, Judge with quoted evidence for both sides. Risk: high false-positive rate in the literature; review-only, small daily cap, separate "true at different times" outcome.
10. **`last_verified` frontmatter and verification intervals per folder.** Detection: Rule (date math). Risk: low. Single-user now; becomes owner verification in team vaults.
11. **Cadence: save-time rules, 3 to 4 hour incremental sweep, daily idle full sweep, weekly contradiction scan.** Detection: manifest diff. Risk: low, as long as Judge calls are capped per sweep and paused while the user is active.
12. **Team mode: owners, owner-routed approvals, permission-scoped evidence, attributed edits, append-only audit log, every rule restarts in review.** Risk: high if skipped. Build the data fields now (owner, approver, run id) so the local schema does not need a migration later.

## Claims not verified

- Letta sleep-time paper numbers (5x compute, 18% accuracy) came from a secondary summary.
- Claude Code Auto Dream details (24h, 5 sessions, four phases) came from third-party blogs, not Anthropic docs.
- Notion expired pages losing search and AI priority came from a third-party blog.
- Claude Code subscription usage limits for background jobs were not checked.
- The token table uses assumed note sizes and counts, not a measurement of a real vault.
