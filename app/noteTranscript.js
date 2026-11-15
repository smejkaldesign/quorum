// A note's summary and transcript, read from its markdown. A note written by Record (in a note, or a summary written
// later) keeps its transcript under a "## Transcript" heading; an older recorded note is the transcript alone, one
// "**Name:** words" paragraph per turn. The reader shows the two as Summary and Transcript tabs.

const TURN = /^\*\*([^*\n]{1,60}):\*\*\s*(.*)$/;
const HEAD = /^##\s+Transcript\s*$/m;

// [{ id, channel, who, text }] from transcript paragraphs; a paragraph that is not a turn continues the one before it
export function parseTurns(text) {
  const turns = [];
  for (const para of String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    const m = para.match(TURN);
    if (m) turns.push({ id: turns.length + 1, channel: 'me', who: m[1].trim(), text: m[2].trim() });
    else if (turns.length) turns[turns.length - 1].text += `\n\n${para}`;
  }
  return turns.filter((t) => t.text);
}

// { summary, transcript: text or null }. recorded is the note's frontmatter flag; without a Transcript heading a
// recorded note whose paragraphs are mostly turns is all transcript
export function splitNote(body, { recorded = false } = {}) {
  const b = String(body ?? '');
  const m = b.match(HEAD);
  if (m) return { summary: b.slice(0, m.index).trim(), transcript: b.slice(m.index + m[0].length).trim() };
  if (!recorded) return { summary: b.trim(), transcript: null };
  const paras = b.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const turns = paras.filter((p) => TURN.test(p)).length;
  return paras.length && turns / paras.length >= 0.6 ? { summary: '', transcript: b.trim() } : { summary: b.trim(), transcript: null };
}

// the body a written summary leaves: the summary, then the transcript kept as it was under its own heading
export const withSummary = (summary, transcript) => `${String(summary).trim()}\n\n## Transcript\n\n${String(transcript).trim()}\n`;

export const SUMMARY_SYSTEM = `You write a short note from a recording's transcript. Plain, literal sentences; no figures of speech. Use only what
the transcript says. Speakers named "Unknown" or "You" were heard through one microphone and may be anyone in the room;
do not credit a person unless the transcript names them. Reply with a first line "Title: " and a 2 to 5 word title,
then a blank line, then markdown: one or two summary sentences, then "## " sections with bullets for the main topics,
and "## Action items" only if someone committed to something.`;

export function parseSummary(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^Title:\s*(.+)$/m);
  const title = m ? m[1].trim().replace(/^["']|["']$/g, '').slice(0, 80) : null;
  const body = (m ? t.slice(m.index + m[0].length) : t).trim();
  return body ? { title, body } : null;
}
