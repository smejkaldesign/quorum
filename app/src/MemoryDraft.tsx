import type { MemoryDraft } from './quorum';

// An agent-drafted fix (memoryDraft.js) as the review drawer and the bulk plan show it: its confidence, what it does,
// each quoted evidence line with its note and line number (Quorum checked every one against the note), and the text it
// writes. compact leaves out the text, for the bulk plan's checklist
const CONFIDENCE = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' } as const;
const WHAT: Record<MemoryDraft['kind'], string> = {
  create: 'The agent wrote the missing note from the linking notes.',
  point: 'The agent read the linking notes and the note Quorum picked.',
  merge: 'The agent merged the two notes into one.',
  contradiction: 'The two notes disagree. The agent rewrote the one that is out of date.',
};

export function DraftEvidence({ draft, compact = false }: { draft: MemoryDraft; compact?: boolean }) {
  return (
    <div className={`md-draft${compact ? ' compact' : ''}`}>
      <div className="md-draft-head">
        <span className={`md-conf ${draft.confidence}`}>{CONFIDENCE[draft.confidence]}</span>
        {!compact && <span className="muted">{WHAT[draft.kind]}</span>}
      </div>
      <ul className="md-quotes" aria-label="Quoted evidence">
        {draft.quotes.map((q, i) => (
          <li key={`${q.path}:${q.line}:${i}`}>
            <span className="md-where">{q.path}, line {q.line}</span>
            <q>{q.text}</q>
          </li>
        ))}
      </ul>
      {!compact && draft.text && (
        <details className="md-text">
          <summary>{draft.kind === 'create' ? 'The note it writes' : draft.kind === 'merge' ? 'The merged note' : 'The rewritten note'}</summary>
          <pre>{draft.text}</pre>
        </details>
      )}
    </div>
  );
}
