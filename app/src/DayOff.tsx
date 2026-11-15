import { useId } from 'react';

// Silly ways to spend a free day. One shows per empty section, the same all day and different the next; seed keeps two
// sections on the same day from showing the same one.
const FREE_TIME = [
  'Alphabetize your spice rack, then do it again by color.',
  'Learn to say "meeting" in five languages, then avoid all five.',
  'Build a fort out of couch cushions and hold a one-person standup inside it.',
  'Name every houseplant you own. Give the cactus a middle name.',
  'Write a thank-you note to your calendar for leaving today blank.',
  'Practice your best surprised face for when the next invite arrives.',
  'Count the ceiling tiles in your house and report the total to no one.',
  'Fold a paper airplane for every meeting you did not have today.',
  'Take a nap and list it on your calendar as a working session.',
  'Rank the snacks in your kitchen from best to worst. Eat the top three.',
  'Teach yourself to juggle with three pairs of rolled-up socks.',
  'Walk to the end of the block and back like you are in a parade.',
  'Draw a map of your home and mark where the remote usually ends up.',
  'Hum the hold music from your last support call until it is stuck again.',
  'Rearrange your desktop icons into the shape of a smiley face.',
  'Find the oldest photo on your phone and recreate the pose.',
  'Make a sandwich with one ingredient you have never put in a sandwich.',
  'Write a three-sentence review of your chair. Be honest.',
  'Stand on one foot for a full minute. Switch feet. Declare victory.',
  'Organize your sock drawer by how much you like each pair.',
  'Learn one card trick and perform it for the first person you see.',
  'Set an out-of-office reply for the next hour, just to see how it feels.',
  'Read the terms and conditions of one app you use. Just one paragraph.',
  'Plan an elaborate lunch, then eat cereal.',
  'Tidy one drawer and tell everyone you cleaned the house.',
  'Make a playlist where every song title is a question.',
  'Try to whistle with a mouthful of crackers. Then do not do that again.',
  'Pick a word and use it in every conversation today without anyone noticing.',
  'Measure how long it takes an ice cube to melt in your hand.',
  'Give yourself a performance review for doing nothing well.',
];
const dayNumber = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
export const freeTimeIdea = (seed = 0) => FREE_TIME[(dayNumber() * 7 + seed * 11) % FREE_TIME.length];

// An empty day (Today, or Next N days with no calls): a small drawing of a sun setting over still water, and a silly
// thing to do with the free time
export function DayOff({ title, seed = 0 }: { title: string; seed?: number }) {
  const sky = `day-off-sky-${useId().replace(/:/g, '')}`;
  return (
    <div className="day-off">
      <svg className="day-off-art" viewBox="0 0 120 72" aria-hidden="true">
        <defs><clipPath id={sky}><rect x="0" y="0" width="120" height="46" /></clipPath></defs>
        <circle cx="60" cy="44" r="18" className="day-off-sun" clipPath={`url(#${sky})`} />
        <path d="M14 46h92" className="day-off-line" />
        <path d="M30 54h60M44 61h32" className="day-off-water" />
        <path d="M60 12v6M38 22l4 4M82 22l-4 4" className="day-off-ray" />
      </svg>
      <div className="day-off-text">
        <p className="day-off-title">{title}</p>
        <p className="hist-empty">{freeTimeIdea(seed)}</p>
      </div>
    </div>
  );
}

