// The Home title: a real quote, five words or fewer, on knowledge, thinking, writing, learning, conversation and
// community, always positive. Bundled with the app, nothing fetched. Each was checked against the Wikiquote (or
// Wikipedia) page it links to: sourced sections only, wording exact, and `find` occurs exactly once on that page
// so the link can scroll to it. Each also fits Home's 60px heading on one line at the default window: five words or
// fewer, 29 characters or fewer, and under 780px measured in the app. The harvest and checks live outside the repo.
import { useEffect, useState } from 'react';
import data from './quotes-data.json';

export type Quote = { text: string; find: string | null; who: string; source: string; url: string };

export const QUOTES = data as Quote[];

// text fragments treat - , & as syntax, so those get percent-encoded too
const fragment = (t: string) => encodeURIComponent(t).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
export const quoteLink = (q: Quote) => (q.find ? `${q.url}#:~:text=${fragment(q.find)}` : q.url);

// a shuffled deck kept on this Mac: every quote shows once before any repeats, and a new deck never opens on the last one
const DECK = 'quorum.quoteDeck';
function drawQuote() {
  let deck: number[] = [];
  try { deck = JSON.parse(localStorage.getItem(DECK) ?? '[]').filter((i: unknown) => typeof i === 'number' && i < QUOTES.length); } catch {}
  let last = -1;
  try { last = Number(localStorage.getItem(`${DECK}.last`) ?? -1); } catch {}
  if (!deck.length) {
    deck = QUOTES.map((_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    if (deck[0] === last && deck.length > 1) [deck[0], deck[1]] = [deck[1], deck[0]];
  }
  const i = deck.shift()!;
  try { localStorage.setItem(DECK, JSON.stringify(deck)); localStorage.setItem(`${DECK}.last`, String(i)); } catch {}
  return QUOTES[i];
}

// one quote per page load, so going back to Home keeps it; a reload or relaunch draws the next one
let current: Quote | null = null;
export function pickQuote() { return (current ??= drawQuote()); }

// Home's quote. The app keeps the one picked at page load; the preview on quorum.watch (site-preview/) sets an
// interval on the bridge and steps through the list
export function useQuote() {
  const everyMs = window.quorum.sitePreview?.quoteMs ?? 0;
  const [quote, setQuote] = useState(pickQuote);
  useEffect(() => {
    if (!everyMs) return;
    const t = setInterval(() => setQuote((q) => QUOTES[(QUOTES.indexOf(q) + 1) % QUOTES.length]), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return quote;
}
