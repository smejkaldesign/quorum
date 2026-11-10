import { describe, expect, it } from 'vitest';
import { fileNameFor, noteMarkdown, parseMeetingDetails, parseMeetingList, parseParticipants, sync } from '../sources/granola.js';

const LIST = `<pagination has_more="true" total_count="5" completion_status="more_available" next_cursor="f667a84c" />

<meetings_data connected_user_email="me@example.com" workspace_name="Me" from="Nov 1, 2026" count="2">
<meeting id="46c1e56f-1b5b" title="Weekly Regroup &amp; Plan" date="Nov 9, 2026 1:00 PM PST" meeting_at="2026-11-09T13:00:00.000-08:00" url="https://notes.granola.ai/d/46c1e56f-1b5b">
    <known_participants>
    Alex Rivera (note creator) from Example (alex@example.com), Dana Whitfield from Example (dana@example.com), Sam Lee
    </known_participants>
    <note_headers>
    Why
    Next Steps
    </note_headers>
  </meeting>
<meeting id="bb6744f5-f2f5" title="1:1" date="Nov 5, 2026 2:00 PM PST" meeting_at="2026-11-05T14:00:00.000-08:00" url="https://notes.granola.ai/d/bb6744f5-f2f5">
    <known_participants>
    Alex Rivera (note creator) from Example (alex@example.com)
    </known_participants>
  </meeting>
</meetings_data>`;

const DETAILS = `<connected_user_email>me@example.com</connected_user_email>
<meetings_data from="Nov 5, 2026" to="Nov 5, 2026" count="1">
<meeting id="bb6744f5-f2f5" title="1:1" date="Nov 5, 2026 2:00 PM PST" meeting_at="2026-11-05T14:00:00.000-08:00" created_at="2026-11-05T14:03:14.628-08:00" updated_at="2026-11-06T14:02:58.676-08:00" url="https://notes.granola.ai/d/bb6744f5-f2f5">
  <known_participants>
  Alex Rivera (note creator) from Example (alex@example.com), Dana Whitfield from Example (dana@example.com)
  </known_participants>
    <folders />
  <private_notes status="empty" />
  <transcript available="true">Advice text the model should ignore.</transcript>
  <summary>
### Topic

- A point with &amp; an ampersand
- **Do the thing** (Alex)
</summary>
</meeting>
</meetings_data>`;

describe('granola parsing', () => {
  it('reads participants with roles and without companies', () => {
    expect(parseParticipants('Alex Rivera (note creator) from Example (alex@example.com), Dana Whitfield from Example (dana@example.com), Sam Lee')).toEqual([
      { name: 'Alex Rivera', recorder: true }, { name: 'Dana Whitfield', recorder: false }, { name: 'Sam Lee', recorder: false },
    ]);
  });
  it('reads a listing page with its cursor', () => {
    const r = parseMeetingList(LIST);
    expect(r.hasMore).toBe(true); expect(r.cursor).toBe('f667a84c');
    expect(r.meetings.map((m) => m.id)).toEqual(['46c1e56f-1b5b', 'bb6744f5-f2f5']);
    expect(r.meetings[0].title).toBe('Weekly Regroup & Plan');
    expect(r.meetings[0].participants).toHaveLength(3);
  });
  it('reads details, decodes entities, drops the transcript advice', () => {
    const [m] = parseMeetingDetails(DETAILS);
    expect(m.privateNotes).toBe('');
    expect(m.summary).toContain('with & an ampersand');
    expect(m.summary).not.toContain('Advice text');
    expect(m.folders).toEqual([]);
    expect(m.updatedAt).toBe('2026-11-06T14:02:58.676-08:00');
  });
  it('writes the vault shape with both ids', () => {
    const [m] = parseMeetingDetails(DETAILS);
    const text = noteMarkdown(m);
    expect(text.startsWith('---\ngranola_id: bb6744f5-f2f5\nsource_id: bb6744f5-f2f5\ntitle: "1:1"\ndate: 2026-11-05T14:00:00.000-08:00\nparticipants:\n  - Alex Rivera (recorder)\n  - Dana Whitfield\nparticipant_count: 2\nsource: granola\nvisibility: private\ngranola_url: https://notes.granola.ai/d/bb6744f5-f2f5\n---\n\n# 1:1\n\n## Summary\n')).toBe(true);
    expect(fileNameFor(m)).toBe('2026-11-05-1-1.md');
  });
});

describe('granola sync', () => {
  const mcp = (calls) => ({ call: async (name, args) => { calls.push([name, args]); if (name === 'search_meetings') return { text: args.cursor ? LIST.replace('has_more="true"', 'has_more="false"').replace(/<meeting id="46c1e56f-1b5b"[\s\S]*?<\/meeting>/, '') : LIST }; return { text: DETAILS }; } });
  it('pages the listing, skips what the vault has, writes the rest', async () => {
    const calls = [], written = [];
    const existing = new Set(['46c1e56f-1b5b']);
    const r = await sync({ mcp: mcp(calls), existing, since: '2020-01-01', write: async (name, text, m) => { written.push([name, m.id]); return name; } });
    expect(calls.filter((c) => c[0] === 'search_meetings')).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({ from_date: '2020-01-01', limit: 100 });
    expect(calls.find((c) => c[0] === 'get_meetings')[1]).toEqual({ meeting_ids: ['bb6744f5-f2f5'], attachments: 'none' });
    expect(written).toEqual([['2026-11-05-1-1.md', 'bb6744f5-f2f5']]);
    expect(r).toMatchObject({ listed: 2, imported: 1, skipped: 1, failed: [] });
    expect(existing.has('bb6744f5-f2f5')).toBe(true);
  });
  it('keeps going when one batch fails and reports it', async () => {
    const failing = { call: async (name) => { if (name === 'search_meetings') return { text: LIST.replace('has_more="true"', 'has_more="false"') }; throw new Error('rate limited'); } };
    const r = await sync({ mcp: failing, existing: new Set(), write: async () => {} });
    expect(r.imported).toBe(0); expect(r.failed).toHaveLength(2); expect(r.failed[0].error).toBe('rate limited');
  });
});
