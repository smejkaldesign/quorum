#!/usr/bin/env node
// Synthetic corpus from macOS `say`: two voices, one per channel, eight short scripted exchanges with fictional
// people and companies. Each channel is rendered to its own 16 kHz mono WAV on a shared timeline (silence while the
// other side speaks), so the files line up the way live capture does. reference.json comes from the script text,
// which gives exact ground truth for the plumbing. Usage: node make-synthetic.mjs [--corpus <dir>]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav } from './wav.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusArg = process.argv.indexOf('--corpus');
const corpus = corpusArg !== -1 ? path.resolve(process.argv[corpusArg + 1]) : path.join(here, 'corpus');
const RATE = 16000, LEAD = 0.5, GAP = 0.7;
const VOICES = { me: 'Samantha', them: 'Daniel' };

const SCRIPTS = [
  { name: 'renewal', entities: ['Thandiwe', 'Brightline Robotics', 'Fieldmap', 'Anneliese Vogt', '$42,000', '8%'], turns: [
    ['me', 'Morning Thandiwe, thanks for making time. I want to lock the Brightline Robotics renewal before the 14th.'],
    ['them', 'Morning. The renewal is $42,000 for 12 months, up 8% from last year.'],
    ['me', '8% is fine if they keep the Fieldmap add-on. Can you confirm with Anneliese Vogt by Thursday?'],
    ['them', 'I will. She asked for the Fieldmap pricing and a copy of the security questionnaire.'],
  ] },
  { name: 'standup', entities: ['Harborfold', 'Postgres', 'Jiro', 'Priya Nandakumar', '1,200', '90 seconds'], turns: [
    ['them', 'Quick update. The Harborfold export job failed twice overnight, both times at 3:15 a.m.'],
    ['me', 'Is that the Postgres timeout again?'],
    ['them', 'Yes. Jiro bumped it to 90 seconds and ran it again. 1,200 records went through clean.'],
    ['me', 'Good. Add it to the retro for Tuesday and tag Priya Nandakumar on the ticket.'],
  ] },
  { name: 'pricing', entities: ['Quillstone', 'Marcus Oyelaran', 'Stripe', '$19', '$49', '20%', '$468', 'March 14th'], turns: [
    ['me', "Let's talk pricing for Quillstone. Two tiers: Starter at $19 a month and Team at $49 per seat."],
    ['them', 'The board wanted a 20% annual discount. That puts Team at about $470 a year.'],
    ['me', 'Round it to $468 so it divides by 12. Ship the page on March 14th.'],
    ['them', "Done. I'll have Marcus Oyelaran update the Stripe products tonight."],
  ] },
  { name: 'hiring', entities: ['Soren Lindqvist', 'Amara Diallo', 'Keiran Doyle', 'Ciaran', 'Northgate Analytics', 'Fernhill', '10:30'], turns: [
    ['them', 'We have three finalists for the design lead role: Soren Lindqvist, Amara Diallo and Keiran Doyle.'],
    ['me', 'Keiran or Kieran? I keep mixing him up with Ciaran from Northgate Analytics.'],
    ['them', 'Keiran, with an E. Different person. His onsite is Wednesday at 10:30.'],
    ['me', 'Book the Fernhill room and send the take-home brief by 5 p.m. today.'],
  ] },
  { name: 'customer', entities: ['Dmitri', 'Cobalt Meadow', 'Okta', 'Azure', 'Nadia Ferreira', '340', '85%'], turns: [
    ['me', 'Thanks for joining, Dmitri. How is the rollout at Cobalt Meadow going?'],
    ['them', 'We have 340 users live across 6 clinics. Adoption is near 85% after 4 weeks.'],
    ['me', "That's ahead of plan. Any blockers on the single sign-on side?"],
    ['them', 'Okta works. The Azure tenant still fails on the redirect, and Nadia Ferreira has a ticket open with your support team.'],
  ] },
  { name: 'budget', entities: ['Lumen Vault', 'Velora', '$212,000', '$230,000', '$18,000', '35%', '$10,000', 'September'], turns: [
    ['them', 'Q3 spend came in at $212,000 against a $230,000 budget.'],
    ['me', 'So $18,000 under. Where did the savings come from?'],
    ['them', 'Mostly cloud. We moved the Lumen Vault backups to cold storage and cut that line by 35%.'],
    ['me', 'Nice. Put $10,000 of it toward the Velora conference in September.'],
  ] },
  { name: 'incident', entities: ['Pinecrest', 'Theo Castellanos', 'October 2nd', '14:05', '11 minutes', '4.7.1'], turns: [
    ['me', 'Walk me through the outage on October 2nd.'],
    ['them', 'At 14:05 UTC the Pinecrest API returned 502s for 11 minutes. Root cause was a bad deploy of version 4.7.1.'],
    ['me', 'Who rolled it back?'],
    ['them', 'Theo Castellanos. He had the rollback done by 14:16, and the status page updated 2 minutes later.'],
  ] },
  { name: 'roadmap', entities: ['Glassbridge', 'Meridian Labs', 'Anneliese Vogt', 'Thandiwe', '$75,000', 'November 20th', 'Q4'], turns: [
    ['them', 'Last thing. Do we keep the Glassbridge integration on the roadmap for Q4?'],
    ['me', 'Yes, but behind the Meridian Labs pilot. Meridian signed a $75,000 pilot yesterday.'],
    ['them', "Then I'll move Glassbridge to November 20th and tell Anneliese Vogt and Thandiwe we're slipping two weeks."],
    ['me', 'Perfect. Send the notes to the team by end of day.'],
  ] },
];

const voices = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
for (const [ch, v] of Object.entries(VOICES)) if (!voices.includes(`${v} `)) { console.error(`voice ${v} for ${ch} is not installed; see System Settings > Accessibility > Spoken Content`); process.exit(1); }

const work = mkdtempSync(path.join(tmpdir(), 'quorum-eval-'));
function render(voice, text, idx) {
  const aiff = path.join(work, `${idx}.aiff`), wav = path.join(work, `${idx}.wav`);
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, wav]);
  return readWav(wav).samples;
}

for (const script of SCRIPTS) {
  const dir = path.join(corpus, `synthetic-${script.name}`);
  mkdirSync(dir, { recursive: true });
  const clips = script.turns.map(([speaker, text], i) => ({ speaker, text, samples: render(VOICES[speaker], text, `${script.name}-${i}`) }));
  let cursor = Math.round(LEAD * RATE);
  const placed = clips.map((c) => { const start = cursor; cursor += c.samples.length + Math.round(GAP * RATE); return { ...c, start }; });
  const total = cursor;
  for (const ch of ['me', 'them']) {
    const out = new Int16Array(total);
    for (const p of placed) if (p.speaker === ch) out.set(p.samples, p.start);
    writeWav(path.join(dir, `${ch}.wav`), out, RATE);
  }
  const reference = { turns: placed.map((p) => ({ speaker: p.speaker, text: p.text, start: +(p.start / RATE).toFixed(2), end: +((p.start + p.samples.length) / RATE).toFixed(2) })), entities: script.entities };
  writeFileSync(path.join(dir, 'reference.json'), JSON.stringify(reference, null, 2) + '\n');
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ source: 'synthetic: macOS say', voices: VOICES, consent: 'not needed, no real speakers', date: new Date().toISOString().slice(0, 10), duration: +(total / RATE).toFixed(2) }, null, 2) + '\n');
  console.log(`${script.name}: ${(total / RATE).toFixed(1)}s, ${script.turns.length} turns`);
}
rmSync(work, { recursive: true, force: true });
