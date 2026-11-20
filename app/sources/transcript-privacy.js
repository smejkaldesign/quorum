// What filing transcripts means for privacy, worded once for every source that offers them (Granola, Zoom, an import
// through the person's own agent). No Node imports: the Connectors page loads this file.
export const TRANSCRIPT_PRIVACY = 'Off by default. A transcript is every word said in the meeting, by everyone in it. Quorum saves it as a plain markdown file in your vault, next to the note. If your vault is a git repository that pushes to a remote such as GitHub, each transcript is pushed there with your next push, and anyone with access to that repository can read it.';

// the extra line when Quorum found that the vault does push somewhere; host is the remote's host name only
export const transcriptRemoteWarning = (host) => `Your vault is a git repository that pushes to ${host || 'a remote'}. Turned on, transcripts go there too unless you add transcripts/ to the vault's .gitignore.`;
