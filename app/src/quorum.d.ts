// set by Vite's define from QUORUM_EDITION at build time (vite.config.ts); 'local' unless the cloud build asked otherwise
declare global {
  const __QUORUM_EDITION__: 'local' | 'cloud';
}

export type HelperEvent =
  | { event: 'transcript'; channel: 'me' | 'them' | 'dictation'; text: string; isFinal: boolean; start: number; end: number; who?: string | null; id?: number; replace?: boolean; at?: number; speaker?: string | null; confidence?: number; cluster?: string | null; corrected?: boolean }
  | { event: 'status'; message: string }
  | { event: 'error'; message: string }
  | { event: 'stopped' }
  | { event: 'ready' }
  | { event: 'chatSent'; text: string }
  | { event: 'axStatus'; trusted: boolean; zoomRunning: boolean }
  | { event: 'audioRoute'; route: 'speakers' | 'headphones' | 'external' | 'unknown'; transport: string; name: string }
  | { event: 'dictation'; state: 'on' | 'off' };

// every generated line carries refs: the ids of the transcript turns it came from
export type Bullet = { text: string; sub: string[]; refs: number[] };
export type Decision = { text: string; status: 'confirmed' | 'suggested'; refs: number[] };
export type ActionItem = { task: string; owner: string | null; due: string | null; refs: number[] };
export type Question = { text: string; refs: number[] };
export type Notes = { title: string; summary: string; sections: { heading: string; bullets: Bullet[] }[]; decisions: Decision[]; actions: ActionItem[]; questions: Question[]; empty?: boolean };
// the final notes as they stream in: the raw text so far and whatever of it already parses
export type NotesDraft = { text: string; partial: Notes | null };
export type MeetingMeta = { title: string; startedAt?: string; minutes: number; participants: number; model: string };
// the speaker pass or a correction, per them turn, plus the names the correction popover offers
export type SpeakersEvent = { turns: { id: number; speaker: string | null; confidence: number; cluster: string | null; corrected: boolean }[]; participants: string[] };

type Unsub = () => void;
export type CalendarEvent = { id: string; title: string; start: string; end: string; item?: string | null; link?: string | null; recurring?: boolean; platform?: 'zoom' | 'meet' | 'teams' | null; join?: string | null };
// the Google Calendar connector: configured means the app has a Google client to sign in with
// guardrails (app/guardrails.js): one list of what the agent may not read or say, from four sources
export type GuardrailKind = 'path' | 'frontmatter' | 'secret' | 'term' | 'hook';
// scope: individual rules are the person's own and work in both editions; organization rules come from the workspace's
// admins and apply to everyone in the organization or team. origin says where an Agent OS candidate was found
export type GuardrailScope = 'individual' | 'organization';
export type GuardrailOrigin = 'hook' | 'terms' | 'claude-md' | 'frontmatter' | 'obsidian';
// reach is what the rule touches once on, from the one table in app/guardrails.js; stale marks an included Agent OS
// rule the Agent OS no longer offers, which keeps enforcing until the person leaves it out
export type GuardrailRule = { id: string; kind: GuardrailKind; label: string; value: string; what?: string; path?: string | null; stage?: 'pre' | 'post'; mixed?: boolean; wired?: boolean; origin?: GuardrailOrigin; count?: number; reach?: string; stale?: boolean; source: 'built-in' | 'agent-os' | 'personal' | 'workspace'; scope: GuardrailScope; enabled: boolean; locked: boolean; decision?: 'included' | 'excluded' | null };
export type GuardrailsState = { rules: GuardrailRule[]; skipped: { name: string; reason: string }[]; scanned: { notes: number; at: number | null; truncated: boolean }; denials: { t: string; tool: string; path: string; reason: string }[]; summary: { on: number; toReview: number; denyDirs: number; terms: number } };
// in-app updates (app/updater.js): off means this build has no feed (a development copy, or a Cloud build without one)
export type UpdateState = { status: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'failed'; current: string; version: string | null; percent: number; notes: string | null; checkedAt: number | null; error: string | null };
// a personal OAuth connector (sources/accounts.js); configured is false when this build has no client id for it
export type OAuthAccount = { id: string; name: string; configured: boolean; connected: boolean; account: string | null; connectedAt: string | null; scope: string; manageUrl: string | null; error: string | null };
// a provider MCP server the agent has (connectors/mcpOverlap.js), with secrets already replaced; where lists the
// places it was found: claude-list (claude mcp list), claude-user, claude-project (~/.claude.json) and vault (.mcp.json)
export type McpOverlapServer = { name: string; url: string | null; command: string | null; args: string[]; where: ('claude-list' | 'claude-user' | 'claude-project' | 'vault')[] };
// matches count; off are set up but turned off in Claude Code. listing: `claude mcp list` is still running;
// claudeMissing: the claude command is not on this Mac
export type McpOverlap = { at: string; read: { claudeList: boolean; claudeConfig: boolean; vault: boolean }; listing: boolean; claudeMissing: boolean; matches: Record<string, McpOverlapServer[]>; off: Record<string, McpOverlapServer[]> };
export type GoogleCalendarStatus = { configured: boolean; connected: boolean; account: string | null; calendars: number; lastSyncAt: string | null; error: string | null };
export type CalendarSettings = { source: 'mac'; days: number; enabled?: boolean; showAll?: boolean; hidden?: string[]; status?: 'granted' | 'notDetermined' | 'denied' | 'unavailable' | 'off'; google?: GoogleCalendarStatus | null };
export type MemoryItem = { id: string; kind: string; label: string; path: string; detail: string; include: boolean | null; manual?: boolean };
export type Memory = { items: MemoryItem[]; excluded: string[]; scannedAt?: string; added?: number; removed?: number; cancelled?: boolean };
export type Profile = { name?: string; title?: string; linkedin?: string; photo?: string };
export type Voice = { locale?: string; sounds?: boolean; dictionary?: { heard: string; write: string }[] };
export type OptOut = { name?: string; domain?: string };
export type DecisionProvider = 'openai' | 'typesafe';
// which environment the main process runs and which Supabase config is active: shell variables, the production .env,
// .env.development, the local stack, or none (local edition). host is the project URL's host; the key never crosses IPC
export type EnvStatus = { env: 'development' | 'production'; config: 'shell' | 'production' | 'development' | 'local' | 'none'; host: string | null; useProduction: boolean; configured: boolean };
export type DecisionsStatus = { connected: boolean; provider: DecisionProvider | null; providers: Record<DecisionProvider, { name: string; placeholder: string; keyHint: string }> };
export type Workspace = { company?: string; companyDescription?: string; companyLogo?: string; neverListen?: string[]; optOuts?: OptOut[]; decisions?: { provider: DecisionProvider; by?: string; at?: string }; stopWord?: string; goWord?: string };
export type Transcription = { echo?: 'auto' | 'off' | 'filter' | 'aec'; gap?: number; live?: boolean; capture?: 'meeting' | 'all'; clean?: boolean; engine?: 'local' | 'managed' };
// where the model runs: none until chosen; claude-code is the only source with tools, so the only one that reads the Agent OS
export type ModelSource = 'none' | 'claude-code' | 'anthropic-api' | 'local';
export type ClaudeStatus = { installed: boolean; loggedIn: boolean; email: string; org: string; plan: string; method: string; version: string };
// every provider in connectors/catalog.js; ConnectorProvider below is the subset a key connects (the hosted Admin list)
export type ConnectorId = ConnectorProvider | 'apple' | 'claude-code' | 'ollama' | 'codex' | 'antigravity';
// which provider handles each step; a missing role falls back (Apple for speech, the legacy switch for the model roles)
export type Providers = Partial<Record<ConnectorRole, ConnectorId>>;
export type ProviderConnectors = Partial<Record<ConnectorId, { baseUrl?: string; model?: string }>>;
export type RunnerStatus = { installed: boolean; version: string | null };
export type ModelSourceStatus = { source: ModelSource; localModel: string; claude: ClaudeStatus | null; key: boolean; keys: Partial<Record<ConnectorId, boolean>>; ollama: { reachable: boolean; hasModel: boolean }; runners?: Partial<Record<'codex' | 'antigravity', RunnerStatus>>; providers: Providers; connectors: ProviderConnectors };
// userName is how the main process names the recorder in notes; it falls back to the macOS account's full name, then the login
export type Settings = { meetingProviders?: Record<string, { enabled: boolean }>; autoListen: boolean; model: 'opus' | 'sonnet' | 'haiku'; modelSource?: ModelSource; localModel?: string; providers?: Providers; connectors?: ProviderConnectors; suggestions: boolean; access?: 'read' | 'write'; userName?: string; profile?: Profile; workspace?: Workspace; voice?: Voice; transcription?: Transcription; notes?: { refs?: boolean }; meetingsKb?: { autoSave?: boolean }; managedModels?: boolean; screenContext?: boolean };
export type OnboardingStatus = { firstRun: boolean; defaultVaultDir: string };
export type OnboardingChecks = { permissions: { microphone: string; audio: string; accessibility: string; calendar: string }; claude: { installed: boolean; loggedIn?: boolean; email?: string; org?: string; plan?: string; version?: string; pending?: boolean }; model?: ModelSourceStatus | null };
// the setup interview: a template plus a few answers that shape a Quorum-built Agent OS (starter.js)
export type SetupTemplate = 'personal' | 'founder' | 'team-lead';
export type SetupAnswers = { template: SetupTemplate; role: string; goals: string; projects: string[]; people: string[]; organize: 'areas' | 'plain' };
// what the form sends: the lists as typed, parsed in the main process
export type SetupInput = Omit<SetupAnswers, 'projects' | 'people'> & { projects: string | string[]; people: string | string[] };
// the keeper: what maintains a Quorum-built folder after each note (keeper.js)
// held: a run that would have created more new files than the keeper's limit, kept back until the user allows it
export type KeeperHeld = { count: number; sample: string[] };
export type KeeperRun = { filed: number; skipped: number; changed: number; reason: string; at: string; error: string | null; off?: boolean; marked?: string[]; held?: KeeperHeld | null };
// one upkeep job (app/plugins.js): owned by Quorum or by the vault, with the files that show the vault already does it
export type PluginOwner = 'quorum' | 'vault';
// report: the plugin reads and shows a result, and writes nothing in the vault on its own; note: one line on what it reads
export type KeeperPlugin = { id: string; title: string; does: string; always: boolean; report: boolean; note: string | null; evidence: { path: string; why: string }[]; owner: PluginOwner; overridden: boolean; isNew: boolean };
export type KeeperStatus = { on: boolean; meetingsIndex: boolean; facts: boolean; running: boolean; lastRunAt: string | null; filed: number; last: KeeperRun | null; folders: Partial<Record<'people' | 'projects' | 'daily' | 'meetings', string>>; model: boolean; held: KeeperHeld | null; plugins: KeeperPlugin[]; learned: KeeperLearned | null; errors: KeeperErrors };
// where learned facts go and how much of the budget they use; errors are upkeep failures logged under Application Support
// pick is the select's value; auto is what Automatic settled on; suggest is the other file when the vault's memory changed since
// note is a vault note (note holds its path; linked says index.md links to it). maxFacts caps the lines in CLAUDE.md by
// default; budgetPick is the budget select's value
export type LearnedTarget = 'claude' | 'learned' | 'note';
export type LearnedAuto = 'claude' | 'learned';
export type KeeperLearned = { target: LearnedTarget; pick: LearnedTarget | 'auto'; auto: LearnedAuto; suggest: LearnedAuto | null; file: string; note: string; linked: boolean; indexGenerated: boolean; budget: number; maxFacts: number | null; budgetPick: number | 'auto' | 'kept'; defaultBudget: number; defaultFacts: number | null; defaultMoves: number; suggestSmall: boolean; small: { budget: number; facts: number }; large: number; chars: number; fileChars: number };
export type KeeperErrors = { count: number; last: { at: string; where: string; message: string } | null; file: string | null };
// the context budget plugin (app/context-budget.js). scope: user, project and memory load every session; nested loads
// only when Claude works in that folder; paths only for matching files. importedBy names the file whose @import loads it. loaded is what Claude Code reads (MEMORY.md stops at 200 lines)
export type ContextFile = { path: string; abs: string; scope: 'user' | 'project' | 'memory' | 'nested' | 'paths'; chars: number; lines: number; tokens: number; loaded: number; warn: string | null; cut?: number; learnedChars: number; importedBy: string | null };
export type ContextBudget = {
  files: ContextFile[]; total: { chars: number; tokens: number }; warnings: string[];
  quorum: { path: string; chars: number; everySession: boolean; share: number | null; aside: { path: string; chars: number } | null } | null;
  agent: { path: string; chars: number; limit: number; cut: number; learnedCut: boolean } | null;
};
// the skill usage plugin (app/skill-usage.js): runs counted from Claude Code transcripts on this Mac. unused is keyed
// by window in days; coverageDays is how far back the transcripts go. Stashed skills carry disable-model-invocation
export type SkillUse = { name: string; dir: string; path: string; runs: number; last: string | null; stashed: boolean; unused: Record<number, boolean>; namedBy: string[] };
export type SkillUsage = { skills: SkillUse[]; transcripts: number; coverageDays: number; windows: number[] };
// the brain check plugin (app/brain-check.js): questions with expected terms, run on the user's own model source
export type BrainCheckItem = { id: string; prompt: string; expect: string[] };
export type BrainCheckResult = BrainCheckItem & { answer: string; error: string | null; pass: boolean; missing: string[] };
export type BrainCheckRun = { at: string; results: BrainCheckResult[] };
export type BrainCheckStatus = { checks: BrainCheckItem[]; last: BrainCheckRun | null; previous: BrainCheckRun | null; running: boolean; done: number; changed: string[]; ready: number };
// screen context: on-screen text as spelling hints; granted is the Screen Recording permission, null when unknown
export type ScreenContextStatus = { available?: boolean; on: boolean; granted: boolean | null };
export type SetupRecord = { version: number; name: string; answers: SetupAnswers; createdAt: string; updatedAt?: string };
// the workspace vault: where teammates' shared notes land on this Mac, with their provenance bonds
export type TeamVault = { root: string; notes: number; behind: number; last: { written: number; behind: number; removed: number; skipped: number } };
export type Brain = { root: string; vault: string; name: string; made?: 'quorum' | null; markers: { agentOS: string | null; obsidian: boolean; search: boolean; safetyHooks: boolean } };
// hosted edition: who is signed in, which organization they are in, and whether notes sync
export type Role = 'owner' | 'admin' | 'member';
// teamEnabled is the Teams page's switch (migration 0019): off, the workspace is one person's and no team-level page shows
export type AccountWorkspace = { id: string; name: string; domain: string | null; domainJoin: boolean; role: Role; teamEnabled?: boolean };
// the beta gate (app/beta.js): gate is true while an access code is still needed; machineId is the anonymous id this
// install reports with its code and version once a day while the beta lasts
export type BetaState = { gate: boolean; on: boolean; code: string | null; plan: 'free' | 'cloud' | string | null; email?: string | null; signedIn?: boolean; acceptedAt: string | null; machineId: string | null; lastHeartbeatAt: number | null };
// feature flags (app/flags.js): each key with its value and where the value came from, in order of precedence env,
// relay, cache (the last relay answer, from an earlier run), defaults (built into the app)
export type FlagSource = 'env' | 'relay' | 'cache' | 'defaults';
// enabled is the effective value; blockedBy names the parent flag (requires) that is off while the flag's own switch is on
export type FlagsState = { flags: Record<string, { enabled: boolean; source: FlagSource; requires?: string; blockedBy?: string; own?: boolean }>; fetchedAt: number | null; source: string; error?: string | null; ok?: boolean };
// the card on file for the workspace's subscription, read through the relay; null when none is stored yet
export type BillingCard = { brand: string; last4: string; expMonth: number; expYear: number } | null;
export type AccountInvite = { inviteId: string; workspaceId: string; workspaceName: string; role: Role; invitedByEmail: string | null; expiresAt: string };
export type AccountState = {
  live?: boolean;
  // false when the build has no Supabase URL and anon key, so there is no hosted account to sign in to
  configured?: boolean;
  signedIn: boolean; email: string | null; userId: string | null;
  workspace: AccountWorkspace | null;
  workspaces: { id: string; name: string; role: Role }[];
  invites: AccountInvite[];
  domainMatches: { workspaceId: string; name: string }[];
  sync: boolean; lastSyncAt: string | null; lastPullAt?: string | null; syncError: string | null;
};
export type Result = { ok?: boolean; error?: string };

// Settings › Sources (sources/catalog.js, sources/jobs.js)
export type SourceMethod = 'connect' | 'folder';
export type SourceJob = { id: string; label: string; status: 'running' | 'done' | 'failed'; phase?: 'list' | 'import'; phaseStartedAt?: number; done: number; total: number | null; message: string | null; error: string | null; failed: { id: string; title: string; error: string }[]; result: { listed: number; imported: number; skipped: number } | null; startedAt: number; finishedAt: number | null };
// a platform account (Zoom first) connected through the relay for cloud recordings; hosted edition only
export type PlatformInfo = { id: string; name: string; available: boolean; connected: boolean; account: string | null; accountName: string | null; lastSyncAt: string | null; imported: number; notes: number; folderPath: string | null; job: SourceJob | null };
// the fallback import through the person's own agent: which runners on this Mac already have the source's MCP server
export type AgentSchedule = 'off' | 'hourly' | 'daily';
export type AgentRunner = { id: string; name: string; server: string; installed: boolean; writable: boolean; note: string | null };
export type AgentImportInfo = { runners: AgentRunner[]; schedule: AgentSchedule; runner: string | null; lastRunAt: string | null; lastResult: string | null };
export type MeetingSourceInfo = { id: string; name: string; kind: 'mcp'; url: string; folder: string; description: string; methods: SourceMethod[]; extras?: string[]; recommended: SourceMethod; why: string; method: SourceMethod; connected: boolean; syncNotes: boolean; syncTranscripts: boolean; transcripts: number; freshNext?: boolean; account?: string | null; lastSyncAt: string | null; imported: number; folderPath: string | null; notes: number; job: SourceJob | null; agent?: AgentImportInfo | null };
// workspace connectors (Settings › Admin › Connectors): a provider key held in Supabase Vault for the whole workspace and
// the roles it may serve. The key never comes back to the client; a draft carries it once, on the way in
export type ConnectorProvider = 'assemblyai' | 'deepgram' | 'elevenlabs' | 'openai' | 'anthropic' | 'google' | 'openai_compatible';
export type ConnectorRole = 'speech' | 'summary' | 'notes' | 'agent' | 'voice';
export type WorkspaceConnector = { id: string; workspaceId: string; provider: ConnectorProvider; label: string; baseUrl: string | null; roles: ConnectorRole[]; createdBy: string | null; createdAt: string; updatedAt: string };
export type ConnectorDraft = { provider: ConnectorProvider; label: string; baseUrl: string | null; roles: ConnectorRole[]; secret: string };
// a library connector a workspace enabled (migration 0030): org mode holds one shared identity whose secret stays in
// the server vault (only secretSet and the last four characters come back); personal mode has each member sign in
export type IntegrationMode = 'org' | 'personal';
export type IntegrationConfig = { scopes: string[]; customScopes: boolean; ownerId: string | null; domain: string | null; mock: boolean; auth: 'api_key' | 'oauth_client'; clientId: string | null };
export type WorkspaceIntegration = { id: string; workspaceId: string; provider: string; mode: IntegrationMode; enabled: boolean; config: IntegrationConfig; secretSet: boolean; secretLast4: string | null; connections: number; createdBy: string | null; createdAt: string; updatedAt: string };
export type IntegrationDraft = { provider: string; mode: IntegrationMode; config: Partial<IntegrationConfig>; secret?: string; enabled?: boolean };
export type ConnectorPolicyInfo = { teamEnabled: boolean; approvedConnectorsOnly: boolean; approvedOnly: boolean; enabled: { id: string; provider: string; mode: IntegrationMode }[] };
// organization voice typing: which connector handles each managed step (absent means Quorum managed), and the hours used
// this calendar month per seat. managedHours is the part on Quorum's keys, the part that counts against the allowance
export type VoiceStep = 'speech' | 'summary' | 'notes';
export type WorkspaceVoice = Partial<Record<VoiceStep, string | null>> & { required?: boolean };
export type SeatUsage = { userId: string; email: string | null; name: string | null; hours: number; managedHours: number };
export type WorkspaceUsage = { period: string; hours: number; managedHours: number; seats: SeatUsage[] };
export type Member ={ userId: string; email: string; name: string | null; role: Role; joinedAt: string };
// the workspace's plan (migration 0008): free is the default, paid after checkout, cloud and internal set by the
// platform owner from the admin app
export type Plan = 'free' | 'cloud' | 'internal' | 'paid';
// the company knowledge review queue (migration 0012): what admins see waiting, and what a member shared
export type QueueItem = { id: string; noteId: string; path: string; title: string; authorEmail: string | null; authorName: string | null; createdAt: string; updatedAt: string | null };
// the Knowledge tab: a shared note as it sits in the workspace vault, and one opened for reading
export type KnowledgeNote = { rel: string; title: string; pulledAt: string | null; behind: boolean; item: string | null };
export type KnowledgeDoc = { rel: string; title: string; body: string; pulledAt: string | null; behind: boolean; update: string | null };
// team knowledge (migration 0020): where the workspace's knowledge comes from, and how it stands on this Mac
export type TeamSourceKind = 'sync' | 'folder' | 'git';
export type TeamSource = { kind: TeamSourceKind; url: string | null; path: string | null; setAt: string | null };
export type TeamSourceDraft = { kind: TeamSourceKind; url?: string; path?: string };
export type TeamLocal = { kind: TeamSourceKind; root: string | null; exists: boolean; lastPullAt: string | null; lastError: string | null; gitAvailable: boolean; notes: number; pulling: boolean };
export type TeamHit = { rel: string; title: string; score: number; line: number; snippet: string };
// knowledge bases (migrations 0024 and 0025; API notes in ee/knowledgeBases.js)
export type KbKind = 'general' | 'meetings';
export type KbRole = 'admin' | 'editor' | 'reader';
export type KbFolder = { id: string; kbId: string; parentId: string | null; name: string; position: number };
export type KbFolderNode = { id: string; parentId: string | null; name: string; position: number; children: KbFolderNode[] };
export type KbAccess = { principal: 'workspace' | 'team' | 'user'; userId: string | null; teamId: string | null; role: KbRole; email: string | null; name: string | null };
export type KbAccessDraft = { principal: 'workspace' | 'team' | 'user'; userId?: string; teamId?: string; role?: KbRole };
// folder and git are Mac-side sources; github and zip record where kb-import last read the KB from
export type KbSource = { kind: 'folder' | 'git' | 'github' | 'zip' | 'hosted'; url: string | null; path: string | null; branch: string | null; subpath: string | null; name: string | null; importedAt: string | null };
export type Kb = { id: string; name: string; kind: KbKind; teamId: string | null; isDefault: boolean; source: KbSource | null; role: KbRole; hosted?: boolean; writable?: boolean; createdAt: string | null; updatedAt: string | null; folders: KbFolderNode[]; access: KbAccess[] | null };
export type KbImportSource = { kind: 'github'; url: string; branch?: string } | { kind: 'zip'; path: string };
export type KbImportRequest = { kbId?: string; name?: string; source?: KbImportSource; folderId?: string };
export type KbImportSkipped = { path: string; reason: string };
// a Google Drive file attached to a KB folder (ee/kbDrive.js); any admin of the KB syncs or removes it
export type KbDriveFile = { fileId: string; noteId: string; name: string; folderId: string | null; url: string | null; syncedAt: string | null; modifiedAt: string | null };
export type KbDriveStatus = { connected: boolean; available: boolean; account: string | null };
export type KbDriveResult = Result & { files?: KbDriveFile[]; synced?: number; unchanged?: number; kept?: number; suggested?: number; skipped?: KbImportSkipped[]; canceled?: true };
// Quorum's edit to a synced KB note, kept as a suggestion after the source changed (ee/kbUpstream.js); KB admins only.
// '~' stands for unchanged lines left out of the view, and its text counts them
export type KbDiffLine = { op: ' ' | '+' | '-' | '~'; text: string };
export type KbSuggestion = { id: string; state: 'ready' | 'stale'; at: string | null; lines: KbDiffLine[]; blocked?: string };
// a remote folder or file the relay keeps in sync in a KB folder (ee/kbSync.js, migration 0032), as KB admins see it
export type KbSyncAttachment = {
  id: string; kb_id: string; folder_id: string | null; provider: 'google-drive' | 'github' | string; remote_id: string; remote_kind: 'folder' | 'file';
  options: { branch?: string; path?: string } | null; name: string; url: string | null; attach_id?: string | null;
  status: 'pending' | 'active' | 'paused' | 'error' | 'needs_auth'; paused_by?: 'admin' | 'plan' | null; error: string | null; note_count: number;
  last_synced_at: string | null; next_run_at: string | null; connected: boolean; account: string | null; attached_by: string | null; attached_by_email: string | null;
};
export type KbSyncResult = Result & { attachment?: KbSyncAttachment | null; canceled?: true };
// a grant Quorum's relay holds for this person's synced folders (ee/kbSync.js, migration 0033); never a token
export type KbSyncGrant = { provider: string; account: string | null; created_at: string; shared_with_mac: boolean; attachments: { id: string; name: string; kb_id: string; kb_name: string; status: string }[] };
export type KbImportProgress = { kbId: string; phase: 'fetching' | 'reading' | 'writing' | 'done'; done: number; total: number };
export type KbPlacement = { noteId: string; kbId: string | null; folderId: string | null; updatedAt: string | null };
export type KbNote = { id: string; path: string; title: string; folderId: string | null; userId: string; updatedAt: string | null };
export type KbHostedNote = { id: string; kbId: string | null; folderId: string | null; path: string; title: string; content: string; hash: string; updatedAt: string | null; editedBy: string | null };
export type KbHostedConflict = { theirs: KbHostedNote | null; merged: string | null };
export type KbHostedSave = { kbId: string; noteId?: string; folderId: string | null; title: string; content: string; baseHash?: string | null; baseContent?: string };
export type KbFile = { id: string; noteId: string; name: string; mime: string; size: number; link: string; createdAt: string | null };
export type ContributionMine = { noteId: string; path: string; status: 'pending' | 'included' | 'declined'; reviewedAt: string | null; createdAt: string };
export type Billing = { plan: Plan; seats: number; seatsIncluded: number; hourPacks: number; members: number; status: string | null; periodEnd: string | null; subscribed: boolean };
export type MemberInvite = { inviteId: string; email: string; role: Role; expiresAt: string };
export type MeetingRow = { id: string; file: string; kind: 'meeting' | 'note'; source: string; title: string; date: string | null; people: string[]; count: number; visibility: Visibility; rel: string; link: string; app: string };
export type ChatRow = { id: string; title: string; date: string; turns: number; meetingFile: string | null; meetingTitle: string | null };
export type Visibility = 'private' | 'public';
// who has read a note: people in Quorum, agents through the read guard or the quorum MCP server
export type NoteViews = { total: number; human: number; agent: number; tokens: number; lastHumanAt: string | null; lastAgentAt: string | null; agents: { via: string; count: number }[] };
export type NoteDoc = { file: string; rel: string; title: string; date?: string; people: string[]; body: string; app: string; url: string; source?: string | null; views?: NoteViews; visibility: Visibility; withheld: boolean; link: string };
export type SavedChat = { id: string; title: string; turns: { q: string; a: string; sources?: Source[]; steps?: string[] }[] };
export type MissingLink = { target: string; sources: string[]; count: number; candidates: { rel: string; title: string; name: string | null; exact: boolean }[] };
export type Relocated = { rel: string; files: number; links: number };
export type SearchHit = { rel: string; title: string; score: number; line: number; snippet: string };
export type Backlink = { rel: string; title: string; line: number; context: string };
export type OutLink = { target: string; rel: string | null; title: string; anchor: string; embed: boolean };
export type TreeItem = { name: string; path: string; dir: boolean; mtime?: number; ctime?: number; children?: TreeItem[] };
export type TreeSort = 'name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc' | 'ctime-desc' | 'ctime-asc';
export type Suggestion = { id: string; kind: 'question' | 'topic'; text: string; caption: string };
// a knowledge base source (Cloud) has kb and no file: rel is where it sits ("Handbook / Policies"), and it opens in the Knowledge tab
export type Source = { n: number; title: string; rel: string; abs: string | null; app: string; url: string; kb?: { kbId: string; noteId: string } };
export type PopupMode = 'detected' | 'starting' | 'listening' | 'failed';
export type PopupEvent = { mode: PopupMode; durationMs: number; autoListen: boolean; provider?: string; chatName?: string; chat?: boolean };
// the running summary during a call: what the model has gathered so far, and whether a pass is in flight
export type SummaryState = { summary: string; decisions: Decision[]; actions: ActionItem[]; questions: Question[]; coveredUntil: number | null };
export type SummaryEvent = { state: SummaryState; at: number; thinking: boolean };
export type StateEvent =
  | { phase: 'listening' | 'paused'; by?: string; go?: string; soft?: boolean; intoNote?: boolean }
  | { phase: 'blocked' }
  | { phase: 'summarizing'; meta?: MeetingMeta }
  | { phase: 'starting'; chatName?: string | null; intoNote?: boolean }
  | { phase: 'idle' }
  | { phase: 'review'; notes: Notes; meta?: MeetingMeta };

// Record in the note view: what is running (audio is Transcription), and a screen read for the open note
export type RecordState = { audio: boolean; screen: boolean; notice?: string };
// who the call app shows, read from its accessibility tree while a recording with Screen on runs
export type CallSpeakersEvent = { at: number; app: string; names: string[]; active: string[] };
// a note opened in the note view; hash is the file as read, so a save can tell it changed on disk
// Keep private for a meeting note (Cloud with a team): available when the workspace has a meetings knowledge base the
// person reads; locked when the note cannot be shared (confidential or withheld lines)
export type MeetingShare = { available: boolean; keepPrivate: boolean; locked: boolean; kbName: string | null; reason: string | null; ask: { key: string; label: string } | null };
// the meeting-notes source accounts a team workspace has seen: the person's choice for each (null until asked and
// answered) and how many past notes "Share past meeting notes" would share
export type MeetingSource = { key: string; label: string; choice: 'share' | 'private' | null; past: number };
export type MeetingSources = { available: boolean; sync?: boolean; workspaceName?: string | null; kbName?: string | null; sources: MeetingSource[] };
export type HandNoteRef = { file: string; hash: string; rel: string; app: string; url: string; frontmatter: string };
export type HandNote = HandNoteRef & { title: string; body: string; readOnly: boolean; date: string | null };
export type HandNoteSave = (HandNoteRef & { propsError?: string }) | { conflict: true } | { error: string };

declare global {
  interface Window {
    quorum: {
      end(): Promise<Notes | null>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      ask(q: string, files?: string[]): Promise<{ text: string; sources: Source[]; steps: string[] }>;
      saveNotes(p: { notes: Notes; followups: { q: string; a: string }[] }): Promise<{ file: string; rel: string; app: string; url: string }>;
      recordStart(opts: RecordState): Promise<RecordState | { error: string }>;
      recordStop(): Promise<RecordState>;
      recordStatus(): Promise<RecordState>;
      onRecord(cb: (s: RecordState) => void): Unsub;
      onCallSpeakers(cb: (e: CallSpeakersEvent) => void): Unsub;
      onNewNote(cb: (d: { file?: string }) => void): Unsub;
      handNoteOpen(file: string): Promise<HandNote | null>;
      handNoteSave(p: { id: string; file: string | null; title: string; body: string; hash: string | null; fresh: boolean; frontmatter?: string }): Promise<HandNoteSave>;
      handNoteDone(file: string | null): Promise<void>;
      privateNotesSet(text: string): Promise<void>;
      discard(): Promise<void>;
      done(): Promise<void>;
      axStatus(): Promise<void>;
      dictate(on: boolean): Promise<{ error: string } | null>;
      pickFiles(): Promise<{ path: string; name: string }[]>;
      stageFile(path: string): Promise<{ staged: string; thumb: string | null }>;
      unstageFile(path: string): Promise<void>;
      onHelperEvent(cb: (e: HelperEvent) => void): Unsub;
      onState(cb: (s: StateEvent) => void): Unsub;
      onSummary(cb: (s: SummaryEvent) => void): Unsub;
      onSpeakers(cb: (s: SpeakersEvent) => void): Unsub;
      nameSpeakers(): Promise<SpeakersEvent>;
      setSpeaker(id: number, name: string | null, similar: boolean): Promise<SpeakersEvent>;
      onLog(cb: (line: string) => void): Unsub;
      onPopup(cb: (p: PopupEvent) => void): Unsub;
      onPopupOut(cb: () => void): () => void;
      launchId: string;
      isDev: boolean;
      // set only by the app preview on quorum.watch (site-preview/mock.ts): Home changes its quote on this interval
      sitePreview?: { quoteMs: number };
      popupMenu(): Promise<void>;
      onSettings(cb: (s: Settings) => void): Unsub;
      onLevel(cb: (v: number) => void): Unsub;
      hideWindow(): Promise<void>;
      hideApp(): Promise<void>;
      quit(): Promise<void>;
      user(): Promise<{ name: string; email: string; photo: string | null }>;
      onSuggestion(cb: (s: Suggestion) => void): Unsub;
      onAgentStep(cb: (s: { text: string }) => void): Unsub;
      // the answer so far, whole, while it streams in
      onAgentDelta(cb: (s: { text: string }) => void): Unsub;
      onNotesDelta(cb: (d: NotesDraft) => void): Unsub;
      onFocusComposer(cb: () => void): Unsub;
      brain(): Promise<Brain | null>;
      connectBrain(): Promise<Brain | null>;
      revealBrain(): Promise<void>;
      disconnectBrain(): Promise<null>;
      clearMeetingsDir(): Promise<true>;
      openBrain(what: 'finder' | 'obsidian' | 'meetings'): Promise<void>;
      meetingsDir(): Promise<{ path: string; rel: string; root: string; notes: number; chosen: boolean; sources: { key: string; name: string; count: number }[] } | null>;
      pickMeetingsDir(): Promise<true | null>;
      neverListTemplate(): Promise<boolean>;
      history(): Promise<{ meetings: MeetingRow[]; chats: ChatRow[] }>;
      readNote(file: string): Promise<NoteDoc | null>;
      newChat(): Promise<void>;
      loadChat(id: string): Promise<SavedChat | null>;
      vaultTree(): Promise<TreeItem[]>;
      vaultGraph(): Promise<import('./Graph').GraphData | null>;
      vaultClusterName(key: string, name: string): Promise<Record<string, string> | null>;
      noteVisibility(file: string, value: Visibility): Promise<Visibility | null>;
      meetingShare(file: string): Promise<MeetingShare>;
      meetingShareSet(file: string, keepPrivate: boolean, hash?: string | null): Promise<{ state: MeetingShare; ref: HandNoteRef } | { conflict: true } | { error: string }>;
      meetingsSources(): Promise<MeetingSources>;
      meetingsSourceSet(key: string, choice: 'share' | 'private'): Promise<{ ok: true; choice: 'share' | 'private' } | { error: string }>;
      meetingsSourceSharePast(key: string): Promise<{ shared: number } | { error: string }>;
      onMeetingsSources(cb: () => void): Unsub;
      noteAsk(file: string, question: string, history: { q: string; a: string }[], files?: string[]): Promise<{ text: string; proposal: string | null }>;
      noteApply(file: string, body: string): Promise<boolean>;
      vaultSearch(q: string, limit?: number): Promise<SearchHit[]>;
      vaultBacklinks(rel: string): Promise<Backlink[]>;
      vaultLinkHealth(): Promise<MissingLink[]>;
      vaultFixLink(target: string, toRel: string): Promise<{ files: number; links: number }>;
      vaultAddAlias(rel: string, alias: string): Promise<boolean>;
      vaultOutgoing(rel: string): Promise<OutLink[]>;
      vaultResolve(target: string, from: string): Promise<string | null>;
      onVaultChanged(cb: (rels: string[]) => void): Unsub;
      vaultNote(rel: string): Promise<{ title: string; body: string; abs: string; app: string; views?: NoteViews } | null>;
      vaultNewNote(folder: string, name: string): Promise<string>;
      vaultNewFolder(parent: string, name: string): Promise<string>;
      vaultRename(rel: string, name: string): Promise<Relocated>;
      vaultMove(rel: string, folder: string): Promise<Relocated>;
      vaultTrash(rel: string): Promise<boolean>;
      vaultReveal(rel: string): Promise<void>;
      vaultSortMenu(current: TreeSort, at?: { x: number; y: number }): Promise<TreeSort | null>;
      vaultMenu(rel: string, isDir: boolean, at?: { x: number; y: number }): Promise<'new-note' | 'duplicate' | 'move' | 'search' | 'rename' | 'reveal' | 'trash' | null>;
      vaultDuplicate(rel: string): Promise<string>;
      acceptSuggestion(id: string): Promise<{ text: string; sources: Source[] }>;
      openNote(abs: string): Promise<void>;
      openExternal(url: string): Promise<void>;
      copy(text: string): Promise<void>;
      popupListen(): Promise<void>;
      popupOpen(): Promise<void>;
      popupDismiss(): Promise<void>;
      getSettings(): Promise<Settings>;
      setSettings(s: Partial<Settings>): Promise<Settings>;
      pickPhoto(): Promise<Settings>;
      memoryGet(): Promise<Memory>;
      memoryRefresh(): Promise<Memory>;
      calendar(): Promise<{ connected: boolean; status: string; events: CalendarEvent[]; days: number; showAll: boolean; hidden: number }>;
      calendarStatus(): Promise<CalendarSettings>;
      sourceIcons(): Promise<Record<string, string | null>>;
      // chat: the STOP/GO notice can be posted in the app's chat (Zoom); running: the app or a browser window for it is open right now
      meetingProviders(): Promise<{ id: string; name: string; installed: boolean; access: boolean | null; enabled: boolean; version: string | null; path: string; inCall: boolean; chat: boolean; running: boolean | null }[]>;
      meetingProviderSet(id: string, on: boolean): Promise<void>;
      meetingProviderCheck(): Promise<void>;
      axSettingsOpen(): Promise<void>;
      decisionsStatus(): Promise<DecisionsStatus>;
      decisionsSet(provider: DecisionProvider, key: string): Promise<{ ok?: boolean; error?: string }>;
      decisionsRemove(): Promise<void>;
      mcpStatus(): Promise<{ added: boolean; node: string; cli: string; command: string }>;
      // the provider MCP servers the agent already has, by connector id; refresh asks for a new pass
      mcpOverlap(opts?: { refresh?: boolean }): Promise<McpOverlap>;
      // runs `claude mcp list` again and waits for it (Check again)
      mcpOverlapCheck(): Promise<McpOverlap>;
      onMcpOverlap(cb: () => void): () => void;
      mcpAdd(): Promise<{ added: boolean; error?: string | null }>;
      mcpRemove(): Promise<{ added: boolean }>;
      cliStatus(): Promise<{ added: boolean; error?: string | null }>;
      cliAdd(): Promise<{ added: boolean; error?: string | null }>;
      cliRemove(): Promise<{ added: boolean }>;
      meetingSources(): Promise<{ id: string; key: string; name: string; manual: boolean; rel: string; notes: number }[]>;
      meetingSourceAdd(): Promise<boolean>;
      meetingSourceRemove(id: string): Promise<boolean>;
      meetingSourceOpen(id: string): Promise<void>;
      sourcesList(): Promise<MeetingSourceInfo[]>;
      libraryIcons(): Promise<Record<string, string | null>>;
      sourceConnect(id: string, opts?: { fresh?: boolean }): Promise<Result & { wrongAccount?: boolean }>;
      onSourceAuthLink(cb: (e: { id: string; url: string; opened: 'window' | null }) => void): Unsub;
      sourceDisconnect(id: string): Promise<Result>;
      sourceSync(id: string): Promise<Result>;
      sourceSetMethod(id: string, method: SourceMethod): Promise<Result>;
      sourceSetOption(id: string, patch: { syncNotes?: boolean; syncTranscripts?: boolean; agentSchedule?: AgentSchedule; agentRunner?: string }): Promise<Result>;
      sourceAgentImport(id: string, runner?: string | null): Promise<Result>;
      platformsList(): Promise<PlatformInfo[]>;
      platformConnect(id: string): Promise<Result>;
      platformDisconnect(id: string): Promise<Result>;
      platformSync(id: string): Promise<Result>;
      onPlatformJob(cb: (job: SourceJob) => void): () => void;
      onSourceJob(cb: (job: SourceJob) => void): Unsub;
      claudeLogin(): Promise<void>;
      claudeStatus(): Promise<ClaudeStatus>;
      modelSourceStatus(): Promise<ModelSourceStatus>;
      modelSourceSet(source: ModelSource): Promise<Settings>;
      localModelSet(name: string): Promise<Settings>;
      modelKeySet(key: string): Promise<{ ok?: boolean; error?: string }>;
      modelKeyRemove(): Promise<void>;
      connectorKeySet(id: ConnectorId, key: string, baseUrl?: string): Promise<Result>;
      connectorKeyRemove(id: ConnectorId): Promise<void>;
      connectorKeyTest(id: ConnectorId, key?: string, baseUrl?: string): Promise<Result>;
      calendarConnect(): Promise<CalendarSettings>;
      calendarSet(next: { days?: number; enabled?: false; showAll?: boolean; hide?: string; unhideAll?: boolean }): Promise<CalendarSettings>;
      calendarPrivacy(): Promise<void>;
      calendarOpen(ev: CalendarEvent): Promise<void>;
      guardrailsGet(opts?: { fresh?: boolean }): Promise<GuardrailsState>;
      guardrailsSet(id: string, patch: { enabled?: boolean; label?: string }): Promise<Result>;
      guardrailsAdd(rule: { kind: string; value: string; label?: string }): Promise<Result & { id?: string }>;
      guardrailsRemove(id: string): Promise<Result>;
      guardrailsTest(rel: string): Promise<{ blocked: string | null }>;
      workspaceGuardrailsGet(): Promise<{ rules?: GuardrailRule[]; error?: string }>;
      workspaceGuardrailsSet(rules: Partial<GuardrailRule>[]): Promise<{ rules?: GuardrailRule[]; error?: string }>;
      updateStatus(): Promise<UpdateState>;
      updateCheck(): Promise<UpdateState>;
      updateInstall(): Promise<boolean>;
      onUpdate(cb: (s: UpdateState) => void): Unsub;
      oauthAccounts(): Promise<OAuthAccount[]>;
      oauthConnect(id: string): Promise<OAuthAccount | { error: string }>;
      oauthDisconnect(id: string): Promise<OAuthAccount | { error: string }>;
      memoryRefreshCancel(): Promise<void>;
      memoryAdd(): Promise<Memory>;
      memoryInclude(id: string): Promise<Memory>;
      memoryExclude(id: string): Promise<Memory>;
      memoryOpen(id: string): Promise<void>;
      removePhoto(): Promise<Settings>;
      onboardingStatus(): Promise<OnboardingStatus>;
      onboardingChecks(): Promise<OnboardingChecks>;
      onboardingPermissions(): Promise<Pick<OnboardingChecks, 'permissions'>>;
      onboardingCreateVault(dir: string | null, name: string, answers?: SetupInput | null): Promise<Brain>;
      onboardingSetupSuggest(): Promise<{ available: boolean; suggestion?: SetupAnswers | null }>;
      setupRead(): Promise<SetupRecord | null>;
      setupRerun(answers: SetupInput): Promise<Brain & { written: string[] }>;
      keeperStatus(): Promise<KeeperStatus>;
      screenContextStatus(): Promise<ScreenContextStatus>;
      screenContextSet(on: boolean): Promise<ScreenContextStatus>;
      screenContextPrivacy(): Promise<void>;
      keeperSet(patch: { on?: boolean; facts?: boolean; factsBudget?: number | 'auto'; factsTarget?: LearnedTarget | 'auto'; factsNote?: string; meetingsIndex?: boolean }): Promise<KeeperStatus>;
      keeperRun(opts?: { allowCreate?: boolean }): Promise<KeeperRun>;
      keeperPlugin(id: string, owner: PluginOwner): Promise<KeeperStatus>;
      keeperErrorsOpen(): Promise<void>;
      keeperErrorsClear(): Promise<KeeperStatus>;
      pluginContext(): Promise<ContextBudget | null>;
      pluginSkills(): Promise<SkillUsage | null>;
      pluginSkillStash(dir: string, on: boolean): Promise<SkillUsage>;
      brainCheckStatus(): Promise<BrainCheckStatus | null>;
      brainCheckSave(checks: BrainCheckItem[]): Promise<BrainCheckStatus>;
      brainCheckRun(): Promise<BrainCheckStatus>;
      onBrainCheck?(cb: () => void): Unsub;
      onKeeper?(cb: (r: KeeperRun) => void): Unsub;
      onboardingOpenPermission(which: 'microphone' | 'audio' | 'accessibility' | 'calendar'): Promise<void>;
      onboardingRequestMicrophone(): Promise<boolean>;
      onboardingRequestAccessibility(): Promise<void>;
      onboardingPickDir(): Promise<string | null>;
      onboardingDone(): Promise<boolean>;
      accountStatus(): Promise<AccountState>;
      accountSendCode(email: string, accessCode?: string): Promise<Result & { needsCode?: boolean; email?: string }>;
      accountVerifyCode(email: string, code: string): Promise<Result>;
      accountSignOut(): Promise<void>;
      accountGoogle(): Promise<Result>;
      onAccountOAuth(cb: (r: Result) => void): Unsub;
      orgCreate(name: string, domain: string | null, domainJoin: boolean): Promise<Result>;
      orgJoin(target: { inviteId: string } | { workspaceId: string }): Promise<Result>;
      orgSwitch(workspaceId: string): Promise<Result>;
      membersList(): Promise<{ members: Member[]; invites: MemberInvite[] } | { error: string }>;
      memberInvite(email: string, role: Role): Promise<Result>;
      memberRemove(userId: string): Promise<Result>;
      inviteRevoke(inviteId: string): Promise<Result>;
      syncSet(on: boolean): Promise<Result>;
      syncNow(): Promise<{ pushed?: { notes: number; meetings: number }; pulled?: { notes: number; conflicts: number; removed: number } | null; error?: string }>;
      onAccount(cb: (s: AccountState) => void): Unsub;
      connectorsList(): Promise<{ connectors?: WorkspaceConnector[]; error?: string }>;
      connectorSet(draft: ConnectorDraft): Promise<{ connector?: WorkspaceConnector; error?: string }>;
      connectorRemove(id: string): Promise<Result>;
      connectorTest(p: { provider: ConnectorProvider; baseUrl: string | null; secret: string }): Promise<Result>;
      workspaceUsage(): Promise<{ usage?: WorkspaceUsage; error?: string }>;
      workspaceVoiceGet(): Promise<{ voice?: WorkspaceVoice; error?: string }>;
      workspaceVoiceSet(voice: WorkspaceVoice): Promise<{ voice?: WorkspaceVoice; error?: string }>;
      integrationsAdmin(): Promise<{ integrations?: WorkspaceIntegration[]; policy?: ConnectorPolicyInfo; error?: string }>;
      integrationSave(draft: IntegrationDraft): Promise<{ integration?: WorkspaceIntegration; error?: string }>;
      integrationEnable(id: string, on: boolean): Promise<{ integration?: WorkspaceIntegration; error?: string }>;
      integrationRemove(id: string): Promise<Result>;
      approvedOnlySet(on: boolean): Promise<Result & { approvedConnectorsOnly?: boolean }>;
      connectorPolicy(): Promise<{ policy: ConnectorPolicyInfo | null }>;
      memberIntegrationsSync(connected: string[]): Promise<{ ok: boolean }>;
      knowledgeStatus(): Promise<Result & { autoInclude?: boolean; mine?: ContributionMine[]; team?: TeamVault | null }>;
      knowledgeTeamOpen(): Promise<Result>;
      knowledgeList(): Promise<Result & { root?: string | null; notes?: KnowledgeNote[] }>;
      knowledgeRead(rel: string): Promise<Result & { doc?: KnowledgeDoc }>;
      knowledgeQueue(): Promise<Result & { queue?: QueueItem[] }>;
      knowledgeReview(id: string, decision: 'include' | 'decline'): Promise<Result & { status?: string }>;
      knowledgeAutoIncludeSet(on: boolean): Promise<Result & { autoInclude?: boolean }>;
      teamSource(): Promise<Result & { source?: TeamSource; local?: TeamLocal }>;
      teamSourceSet(draft: TeamSourceDraft): Promise<Result & { source?: TeamSource; local?: TeamLocal }>;
      teamSourcePick(): Promise<Result & { path?: string; local?: TeamLocal }>;
      teamPull(): Promise<Result & { local?: TeamLocal }>;
      teamTree(): Promise<Result & { tree?: TreeItem[] }>;
      teamSearch(q: string, limit?: number): Promise<Result & { hits?: TeamHit[] }>;
      teamGraph(): Promise<Result & { graph?: import('./Graph').GraphData | null }>;
      teamNote(rel: string): Promise<Result & { doc?: KnowledgeDoc }>;
      teamResolve(target: string, from: string): Promise<Result & { rel?: string | null }>;
      onTeamChanged(cb: (rels: string[]) => void): Unsub;
      kbList(): Promise<Result & { kbs?: Kb[] }>;
      kbCreate(draft: { name: string; kind?: KbKind }): Promise<Result & { kb?: Kb }>;
      kbRename(kbId: string, name: string): Promise<Result & { kb?: Kb }>;
      kbDelete(kbId: string): Promise<Result>;
      kbFolderCreate(draft: { kbId: string; parentId?: string | null; name: string; position?: number }): Promise<Result & { folder?: KbFolder }>;
      kbFolderRename(folderId: string, name: string): Promise<Result & { folder?: KbFolder }>;
      // parentId left out keeps the current parent (a reorder); null moves the folder to the KB's top level
      kbFolderMove(draft: { folderId: string; parentId?: string | null; position?: number }): Promise<Result & { folder?: KbFolder }>;
      kbFolderDelete(folderId: string): Promise<Result>;
      kbAccessSet(kbId: string, access: KbAccessDraft[]): Promise<Result & { access?: KbAccess[] }>;
      kbNoteAssign(draft: { noteId?: string; path?: string; kbId: string | null; folderId?: string | null }): Promise<Result & { placement?: KbPlacement }>;
      kbNotes(kbId: string): Promise<Result & { notes?: KbNote[] }>;
      kbHostedCreate(name: string, teamId?: string | null): Promise<Result & { kb?: Kb }>;
      kbHostedNote(noteId: string): Promise<Result & { note?: KbHostedNote }>;
      kbHostedNoteSave(draft: KbHostedSave): Promise<Result & { note?: KbHostedNote; conflict?: KbHostedConflict }>;
      kbHostedNoteMove(noteId: string, folderId: string | null): Promise<Result & { note?: KbHostedNote }>;
      kbHostedNoteDelete(noteId: string, baseHash: string | null): Promise<Result & { ok?: true; conflict?: KbHostedConflict }>;
      kbFiles(noteId: string): Promise<Result & { files?: KbFile[] }>;
      kbFileAttach(noteId: string): Promise<Result & { file?: KbFile; canceled?: true }>;
      kbFileOpen(idOrLink: string): Promise<Result & { ok?: true }>;
      kbFileRemove(fileId: string): Promise<Result & { ok?: true }>;
      kbFilesUsage(): Promise<Result & { used?: number; quota?: number }>;
      onKbOpen(cb: (t: { kbId: string; noteId: string }) => void): Unsub;
      kbOpenReady(): Promise<void>;
      kbSuggestion(noteId: string): Promise<Result & { edited?: boolean; noteHash?: string | null; suggestions?: KbSuggestion[] }>;
      // noteHash is the note's hash as the page read it; changed says the note moved on and the page reads again
      kbSuggestionApply(noteId: string, suggestionId: string, noteHash: string | null): Promise<Result & { ok?: true; title?: string | null; body?: string; changed?: true }>;
      kbSuggestionDismiss(noteId: string, suggestionId: string): Promise<Result & { ok?: true }>;
      kbImport(req: KbImportRequest): Promise<Result & { kb?: Kb; imported?: number; removed?: number; kept?: number; suggested?: number; skipped?: KbImportSkipped[] }>;
      kbImportPickZip(): Promise<{ path?: string; canceled?: true }>;
      onKbImportProgress(cb: (p: KbImportProgress) => void): Unsub;
      kbDriveStatus(): Promise<KbDriveStatus>;
      kbDriveFiles(kbId: string): Promise<Result & { files?: KbDriveFile[] }>;
      kbDriveAdd(req: { kbId: string; folderId?: string | null }): Promise<KbDriveResult>;
      kbDriveCancel(): Promise<{ canceled: boolean }>;
      kbDriveSync(req: { kbId: string; fileId?: string }): Promise<KbDriveResult>;
      kbDriveRemove(req: { kbId: string; fileId: string }): Promise<Result & { files?: KbDriveFile[] }>;
      kbSyncList(kbId: string): Promise<Result & { attachments?: KbSyncAttachment[] }>;
      kbSyncAttachDrive(req: { kbId: string; folderId?: string | null }): Promise<KbSyncResult>;
      kbSyncAttachGithub(req: { kbId: string; folderId?: string | null; url: string; branch?: string | null }): Promise<KbSyncResult>;
      kbSyncCancel(): Promise<{ canceled: boolean }>;
      kbSyncPause(req: { id: string; paused: boolean }): Promise<KbSyncResult>;
      kbSyncNow(req: { id: string }): Promise<KbSyncResult>;
      kbSyncRemove(req: { id: string }): Promise<Result & { removed?: number }>;
      kbSyncGrants(): Promise<Result & { grants?: KbSyncGrant[] }>;
      kbSyncGrantDisconnect(req: { provider: string; mode: 'pause' | 'remove' }): Promise<Result & { paused?: number; removed?: number }>;
      billingStatus(): Promise<Result & { billing?: Billing }>;
      billingCheckout(seats?: number): Promise<Result>;
      billingPortal(): Promise<Result>;
      billingPacks(packs: number): Promise<Result & { packs?: number; remainingSeconds?: number }>;
      billingCard(): Promise<Result & { card?: BillingCard }>;
      teamEnabledSet(on: boolean): Promise<AccountState & { error?: string }>;
      betaStatus(): Promise<BetaState>;
      // refused: the code itself was turned down (clear it); false when the relay could not be reached or failed
      betaCheck(code: string): Promise<{ ok: boolean; plan?: string; email?: string | null; notice?: string | null; reason?: string; refused?: boolean; status?: BetaState }>;
      flags(): Promise<FlagsState>;
      flagsRefresh(): Promise<FlagsState>;
      onFlags(cb: (s: FlagsState) => void): Unsub;
      envStatus(): Promise<EnvStatus>;
      envSetProduction(on: boolean): Promise<EnvStatus>;
    };
  }
}
