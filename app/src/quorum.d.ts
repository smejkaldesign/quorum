// set by Vite's define from QUORUM_EDITION at build time (vite.config.ts); 'local' unless the cloud build asked otherwise
declare global {
  const __QUORUM_EDITION__: 'local' | 'cloud';
}

export type HelperEvent =
  | { event: 'transcript'; channel: 'me' | 'them' | 'dictation'; text: string; isFinal: boolean; start: number; end: number; who?: string | null }
  | { event: 'status'; message: string }
  | { event: 'error'; message: string }
  | { event: 'stopped' }
  | { event: 'ready' }
  | { event: 'chatSent'; text: string }
  | { event: 'axStatus'; trusted: boolean; zoomRunning: boolean }
  | { event: 'dictation'; state: 'on' | 'off' };

export type ActionItem = { title: string; owner: string | null };
export type Notes = { title: string; sections: { heading: string; bullets: { text: string; sub: string[] }[] }[]; nextSteps: ActionItem[]; empty?: boolean };
export type MeetingMeta = { title: string; startedAt?: string; minutes: number; participants: number; model: string };

type Unsub = () => void;
export type CalendarEvent = { id: string; title: string; start: string; end: string; item?: string; recurring?: boolean; platform?: 'zoom' | 'meet' | 'teams' | null; join?: string | null };
export type CalendarSettings = { source: 'mac'; days: number; enabled?: boolean; showAll?: boolean; hidden?: string[]; status?: 'granted' | 'notDetermined' | 'denied' | 'unavailable' };
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
export type Transcription = { echo?: 'off' | 'filter' | 'aec'; gap?: number; live?: boolean; capture?: 'meeting' | 'all' };
// where the model runs: none until chosen; claude-code is the only source with tools, so the only one that reads the Agent OS
export type ModelSource = 'none' | 'claude-code' | 'anthropic-api' | 'local';
export type ClaudeStatus = { installed: boolean; loggedIn: boolean; email: string; org: string; plan: string; method: string; version: string };
export type ModelSourceStatus = { source: ModelSource; localModel: string; claude: ClaudeStatus | null; key: boolean; ollama: { reachable: boolean; hasModel: boolean } };
// userName is how the main process names the recorder in notes; it falls back to the macOS account's full name, then the login
export type Settings = { autoListen: boolean; model: 'opus' | 'sonnet' | 'haiku'; modelSource?: ModelSource; localModel?: string; suggestions: boolean; access?: 'read' | 'write'; userName?: string; profile?: Profile; workspace?: Workspace; voice?: Voice; transcription?: Transcription };
export type OnboardingStatus = { firstRun: boolean; defaultVaultDir: string };
export type OnboardingChecks = { permissions: { microphone: string; audio: string; accessibility: string; calendar: string }; claude: { installed: boolean; loggedIn?: boolean; email?: string; org?: string; plan?: string; version?: string; pending?: boolean }; model?: ModelSourceStatus | null };
export type Brain = { root: string; vault: string; name: string; markers: { agentOS: string | null; obsidian: boolean; search: boolean; safetyHooks: boolean } };
// hosted edition: who is signed in, which organization they are in, and whether notes sync
export type Role = 'owner' | 'admin' | 'member';
export type AccountWorkspace = { id: string; name: string; domain: string | null; domainJoin: boolean; role: Role };
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
export type Member = { userId: string; email: string; name: string | null; role: Role; joinedAt: string };
export type MemberInvite = { inviteId: string; email: string; role: Role; expiresAt: string };
export type MeetingRow = { id: string; file: string; kind: 'meeting' | 'note'; source: string; title: string; date: string | null; people: string[]; count: number; visibility: Visibility; rel: string; link: string; app: string };
export type ChatRow = { id: string; title: string; date: string; turns: number; meetingFile: string | null; meetingTitle: string | null };
export type Visibility = 'private' | 'public';
export type NoteDoc = { file: string; rel: string; title: string; date?: string; people: string[]; body: string; app: string; url: string; visibility: Visibility; withheld: boolean; link: string };
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
export type PopupEvent = { mode: PopupMode; durationMs: number; autoListen: boolean };
export type StateEvent =
  | { phase: 'listening' | 'paused'; by?: string; go?: string; soft?: boolean }
  | { phase: 'blocked' }
  | { phase: 'summarizing'; meta?: MeetingMeta }
  | { phase: 'starting' }
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
      discard(): Promise<void>;
      done(): Promise<void>;
      axStatus(): Promise<void>;
      dictate(on: boolean): Promise<void>;
      pickFiles(): Promise<{ path: string; name: string }[]>;
      stageFile(path: string): Promise<{ staged: string; thumb: string | null }>;
      unstageFile(path: string): Promise<void>;
      onHelperEvent(cb: (e: HelperEvent) => void): Unsub;
      onState(cb: (s: StateEvent) => void): Unsub;
      onLog(cb: (line: string) => void): Unsub;
      onPopup(cb: (p: PopupEvent) => void): Unsub;
      onPopupOut(cb: () => void): () => void;
      launchId: string;
      isDev: boolean;
      popupMenu(): Promise<void>;
      onSettings(cb: (s: Settings) => void): Unsub;
      onLevel(cb: (v: number) => void): Unsub;
      hideWindow(): Promise<void>;
      quit(): Promise<void>;
      user(): Promise<{ name: string; email: string; photo: string | null }>;
      onSuggestion(cb: (s: Suggestion) => void): Unsub;
      onAgentStep(cb: (s: { text: string }) => void): Unsub;
      onFocusComposer(cb: () => void): Unsub;
      brain(): Promise<Brain | null>;
      connectBrain(): Promise<Brain | null>;
      revealBrain(): Promise<void>;
      openBrain(what: 'finder' | 'obsidian' | 'meetings'): Promise<void>;
      meetingsDir(): Promise<{ path: string; rel: string; notes: number; chosen: boolean } | null>;
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
      vaultNote(rel: string): Promise<{ title: string; body: string; abs: string; app: string } | null>;
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
      claudeLogin(): Promise<void>;
      claudeStatus(): Promise<ClaudeStatus>;
      modelSourceStatus(): Promise<ModelSourceStatus>;
      modelSourceSet(source: ModelSource): Promise<Settings>;
      localModelSet(name: string): Promise<Settings>;
      modelKeySet(key: string): Promise<{ ok?: boolean; error?: string }>;
      modelKeyRemove(): Promise<void>;
      calendarConnect(): Promise<CalendarSettings>;
      calendarSet(next: { days?: number; enabled?: false; showAll?: boolean; hide?: string; unhideAll?: boolean }): Promise<CalendarSettings>;
      calendarPrivacy(): Promise<void>;
      calendarOpen(ev: CalendarEvent): Promise<void>;
      memoryRefreshCancel(): Promise<void>;
      memoryAdd(): Promise<Memory>;
      memoryInclude(id: string): Promise<Memory>;
      memoryExclude(id: string): Promise<Memory>;
      memoryOpen(id: string): Promise<void>;
      removePhoto(): Promise<Settings>;
      onboardingStatus(): Promise<OnboardingStatus>;
      onboardingChecks(): Promise<OnboardingChecks>;
      onboardingCreateVault(dir: string | null, name: string): Promise<Brain>;
      onboardingOpenPermission(which: 'microphone' | 'audio' | 'accessibility' | 'calendar'): Promise<void>;
      onboardingRequestMicrophone(): Promise<boolean>;
      onboardingDone(): Promise<boolean>;
      accountStatus(): Promise<AccountState>;
      accountSendCode(email: string): Promise<Result>;
      accountVerifyCode(email: string, code: string): Promise<Result>;
      accountSignOut(): Promise<void>;
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
      envStatus(): Promise<EnvStatus>;
      envSetProduction(on: boolean): Promise<EnvStatus>;
    };
  }
}
