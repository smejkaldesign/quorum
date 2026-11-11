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
export type GuardrailRule = { id: string; kind: GuardrailKind; label: string; value: string; what?: string; path?: string; stage?: 'pre' | 'post'; mixed?: boolean; wired?: boolean; source: 'built-in' | 'agent-os' | 'personal' | 'workspace'; enabled: boolean; locked: boolean; decision?: 'included' | 'excluded' | null };
export type GuardrailsState = { rules: GuardrailRule[]; skipped: { name: string; reason: string }[]; denials: { t: string; tool: string; path: string; reason: string }[]; summary: { on: number; toReview: number; denyDirs: number; terms: number } };
// in-app updates (app/updater.js): off means this build has no feed (a development copy, or a Cloud build without one)
export type UpdateState = { status: 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'failed'; current: string; version: string | null; percent: number; notes: string | null; checkedAt: number | null; error: string | null };
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
export type Workspace = { company?: string; companyDescription?: string; neverListen?: string[]; optOuts?: OptOut[]; decisions?: { provider: DecisionProvider; by?: string; at?: string }; stopWord?: string; goWord?: string };
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
export type Settings = { meetingProviders?: Record<string, { enabled: boolean }>; autoListen: boolean; model: 'opus' | 'sonnet' | 'haiku'; modelSource?: ModelSource; localModel?: string; providers?: Providers; connectors?: ProviderConnectors; suggestions: boolean; access?: 'read' | 'write'; userName?: string; profile?: Profile; workspace?: Workspace; voice?: Voice; transcription?: Transcription; notes?: { refs?: boolean }; managedModels?: boolean };
export type OnboardingStatus = { firstRun: boolean; defaultVaultDir: string };
export type OnboardingChecks = { permissions: { microphone: string; audio: string; accessibility: string; calendar: string }; claude: { installed: boolean; loggedIn?: boolean; email?: string; org?: string; plan?: string; version?: string; pending?: boolean }; model?: ModelSourceStatus | null };
// the setup interview: a template plus a few answers that shape a Quorum-built Agent OS (starter.js)
export type SetupTemplate = 'personal' | 'founder' | 'team-lead';
export type SetupAnswers = { template: SetupTemplate; role: string; goals: string; projects: string[]; people: string[]; organize: 'areas' | 'plain' };
// what the form sends: the lists as typed, parsed in the main process
export type SetupInput = Omit<SetupAnswers, 'projects' | 'people'> & { projects: string | string[]; people: string | string[] };
// the keeper: what maintains a Quorum-built folder after each note (keeper.js)
export type KeeperRun = { filed: number; skipped: number; changed: number; reason: string; at: string; error: string | null; off?: boolean };
export type KeeperStatus = { on: boolean; facts: boolean; running: boolean; lastRunAt: string | null; filed: number; last: KeeperRun | null; folders: Partial<Record<'people' | 'projects' | 'daily' | 'meetings', string>>; model: boolean };
export type SetupRecord = { version: number; name: string; answers: SetupAnswers; createdAt: string; updatedAt?: string };
// the workspace vault: where teammates' shared notes land on this Mac, with their provenance bonds
export type TeamVault = { root: string; notes: number; behind: number; last: { written: number; behind: number; removed: number; skipped: number } };
export type Brain = { root: string; vault: string; name: string; made?: 'quorum' | null; markers: { agentOS: string | null; obsidian: boolean; search: boolean; safetyHooks: boolean } };
// hosted edition: who is signed in, which organization they are in, and whether notes sync
export type Role = 'owner' | 'admin' | 'member';
export type AccountWorkspace = { id: string; name: string; domain: string | null; domainJoin: boolean; role: Role };
export type AccountInvite = { inviteId: string; workspaceId: string; workspaceName: string; role: Role; invitedByEmail: string | null; expiresAt: string };
export type AccountState = {
  live?: boolean;
  // false when the build has no Supabase URL and anon key, so there is no hosted account to sign in to
  configured?: boolean;
  signedIn: boolean; email: string | null; userId: string | null;
  // the platform owner role (migration 0008): outside any workspace, sees the Platform page behind Admin
  platformOwner?: boolean;
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
// organization voice typing: which connector handles each managed step (absent means Quorum managed), and the hours used
// this calendar month per seat. managedHours is the part on Quorum's keys, the part that counts against the allowance
export type VoiceStep = 'speech' | 'summary' | 'notes';
export type WorkspaceVoice = Partial<Record<VoiceStep, string | null>> & { required?: boolean };
export type SeatUsage = { userId: string; email: string | null; name: string | null; hours: number; managedHours: number };
export type WorkspaceUsage = { period: string; hours: number; managedHours: number; seats: SeatUsage[] };
export type Member ={ userId: string; email: string; name: string | null; role: Role; joinedAt: string };
// the platform owner's view (Settings › Admin › Platform): every workspace with its plan and activity, the members of one,
// and its usage this period by step. PlanDraft is what the Set plan form sends
export type Plan = 'free' | 'cloud' | 'internal' | 'paid';
export type PlatformWorkspace = { id: string; name: string; domain: string | null; plan: Plan; seatsIncluded: number; notes: string | null; members: number; createdAt: string; lastActivity: string | null };
export type PlanDraft = { plan: Plan; seatsIncluded: number; notes: string };
// what the workspace pays for (workspace_billing): the plan is the switch, seats and packs set the managed hours
// the company knowledge review queue (migration 0012): what admins see waiting, and what a member shared
export type QueueItem = { id: string; noteId: string; path: string; title: string; authorEmail: string | null; authorName: string | null; createdAt: string; updatedAt: string | null };
export type ContributionMine = { noteId: string; path: string; status: 'pending' | 'included' | 'declined'; reviewedAt: string | null; createdAt: string };
export type Billing = { plan: Plan; seats: number; seatsIncluded: number; hourPacks: number; members: number; status: string | null; periodEnd: string | null; subscribed: boolean };
// an access code the platform owner issued for one email; Cloud sign-up needs one (migration 0009)
export type AccessCodeStatus = 'open' | 'claimed' | 'redeemed' | 'revoked' | 'expired';
export type AccessCode = { id: string; email: string; code: string; note: string | null; issuedAt: string; expiresAt: string; claimedAt: string | null; redeemedAt: string | null; revokedAt: string | null; redeemedEmail: string | null; status: AccessCodeStatus };
export type PlatformUsage = { period: string; hours: number; managedHours: number; calls: number; steps: { role: string; calls: number; hours: number; managedHours: number }[] };
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
export type Source = { n: number; title: string; rel: string; abs: string; app: string; url: string };
export type PopupMode = 'detected' | 'starting' | 'listening' | 'failed';
export type PopupEvent = { mode: PopupMode; durationMs: number; autoListen: boolean; provider?: string; chatName?: string; chat?: boolean };
// the running summary during a call: what the model has gathered so far, and whether a pass is in flight
export type SummaryState = { summary: string; decisions: Decision[]; actions: ActionItem[]; questions: Question[]; coveredUntil: number | null };
export type SummaryEvent = { state: SummaryState; at: number; thinking: boolean };
export type StateEvent =
  | { phase: 'listening' | 'paused'; by?: string; go?: string; soft?: boolean }
  | { phase: 'blocked' }
  | { phase: 'summarizing'; meta?: MeetingMeta }
  | { phase: 'starting'; chatName?: string | null }
  | { phase: 'idle' }
  | { phase: 'review'; notes: Notes; meta?: MeetingMeta };

declare global {
  interface Window {
    quorum: {
      start(): Promise<void>;
      end(): Promise<Notes | null>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      ask(q: string, files?: string[]): Promise<{ text: string; sources: Source[]; steps: string[] }>;
      saveNotes(p: { notes: Notes; followups: { q: string; a: string }[] }): Promise<{ file: string; rel: string; app: string; url: string }>;
      privateNotesSet(text: string): Promise<void>;
      discard(): Promise<void>;
      done(): Promise<void>;
      axStatus(): Promise<void>;
      dictate(on: boolean): Promise<void>;
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
      noteVisibility(file: string, value: Visibility): Promise<Visibility | null>;
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
      gcalConnect(): Promise<GoogleCalendarStatus>;
      guardrailsGet(): Promise<GuardrailsState>;
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
      gcalDisconnect(): Promise<GoogleCalendarStatus>;
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
      keeperSet(patch: { on?: boolean; facts?: boolean }): Promise<KeeperStatus>;
      keeperRun(): Promise<KeeperRun>;
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
      platformWorkspaces(): Promise<{ workspaces?: PlatformWorkspace[]; error?: string }>;
      platformMembers(workspaceId: string): Promise<{ members?: Member[]; error?: string }>;
      platformUsage(workspaceId: string): Promise<{ usage?: PlatformUsage; error?: string }>;
      platformSetPlan(workspaceId: string, draft: PlanDraft): Promise<{ plan?: { plan: Plan; seatsIncluded: number; notes: string | null }; error?: string }>;
      knowledgeStatus(): Promise<Result & { autoInclude?: boolean; mine?: ContributionMine[]; team?: TeamVault | null }>;
      knowledgeTeamOpen(): Promise<Result>;
      knowledgeQueue(): Promise<Result & { queue?: QueueItem[] }>;
      knowledgeReview(id: string, decision: 'include' | 'decline'): Promise<Result & { status?: string }>;
      knowledgeAutoIncludeSet(on: boolean): Promise<Result & { autoInclude?: boolean }>;
      billingStatus(): Promise<Result & { billing?: Billing }>;
      billingCheckout(seats?: number): Promise<Result>;
      billingPortal(): Promise<Result>;
      billingPacks(packs: number): Promise<Result & { packs?: number; remainingSeconds?: number }>;
      platformAccessCodes(): Promise<Result & { codes?: AccessCode[] }>;
      platformIssueAccessCode(email: string, note?: string, days?: number): Promise<Result & { code?: AccessCode }>;
      platformRevokeAccessCode(id: string): Promise<Result>;
      envStatus(): Promise<EnvStatus>;
      envSetProduction(on: boolean): Promise<EnvStatus>;
    };
  }
}
