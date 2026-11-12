import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRequest, codeEmail, corsHeaders, createLimiter, signupNotice } from '../platform.js';

describe('access request intake', () => {
  it('keeps a real email, trims and bounds the rest, and names the source in one word', () => {
    const r = cleanRequest({ email: ' Beta.Person@Example.COM ', name: '  Beta Person  ', note: 'x'.repeat(1200), source: 'Site Footer!' });
    assert.equal(r.email, 'beta.person@example.com');
    assert.equal(r.name, 'Beta Person');
    assert.equal(r.note.length, 1000);
    assert.equal(r.source, 'sitefooter');
    assert.deepEqual(cleanRequest({ email: 'a@example.com' }), { email: 'a@example.com', name: null, note: null, source: 'site' });
  });
  it('refuses anything that is not an email address', () => {
    for (const email of ['', 'nope', 'a@b', 'a b@c.d']) assert.throws(() => cleanRequest({ email }), /full email address/);
  });
  it('allows a handful of requests an hour per address and then stops', () => {
    let t = 0;
    const l = createLimiter({ max: 3, windowMs: 1000, now: () => t });
    assert.deepEqual([l.allow('a'), l.allow('a'), l.allow('a'), l.allow('a')], [true, true, true, false]);
    assert.equal(l.allow('b'), true);
    t = 1001;
    assert.equal(l.allow('a'), true);
  });
  it('answers CORS only for the listed origins', () => {
    const allowed = ['https://quorum.watch', 'https://admin.quorum.watch'];
    assert.equal(corsHeaders('https://quorum.watch', allowed)['access-control-allow-origin'], 'https://quorum.watch');
    assert.deepEqual(corsHeaders('https://evil.example', allowed), {});
    assert.deepEqual(corsHeaders(undefined, allowed), {});
  });
});

describe('the code email', () => {
  it('carries the code in XXXX-XXXX form, the download link, the steps and the expiry, in text and html', () => {
    const m = codeEmail({ email: 'x@example.com', name: 'Ada Lovelace', code: 'K7PQ2MX9', expiresAt: '2026-12-26T00:00:00Z', downloadUrl: 'https://example.com/q.dmg' });
    assert.equal(m.to, 'x@example.com');
    assert.equal(m.subject, "You're approved for Quorum Cloud");
    assert.equal(m.plan, 'cloud');
    assert.match(m.text, /Hi Ada,/);
    assert.match(m.text, /approved for Quorum Cloud/);
    assert.match(m.text, /K7PQ-2MX9/);
    assert.match(m.text, /https:\/\/example\.com\/q\.dmg/);
    assert.match(m.text, /lasts until December 2[56], 2026/);
    assert.match(m.html, /K7PQ-2MX9/);
    assert.match(m.html, /<a href="https:\/\/example\.com\/q\.dmg"/);
    assert.doesNotMatch(m.html, /<script/);
  });
  it('escapes a name that carries markup and copes without a name or an expiry', () => {
    const m = codeEmail({ email: 'x@example.com', name: '<b>Bad</b>', code: 'K7PQ2MX9', expiresAt: null, downloadUrl: 'https://example.com' });
    assert.match(m.html, /Hi &lt;b&gt;Bad&lt;\/b&gt;,/);
    assert.match(m.text, /works once\./);
    assert.match(codeEmail({ email: 'x@example.com', code: 'K7PQ2MX9', downloadUrl: 'https://example.com' }).text, /^Hi,/);
  });
  it('a free code names Quorum Free, links the open-source release and skips the sign-in step', () => {
    const m = codeEmail({ email: 'x@example.com', code: 'K7PQ2MX9', downloadUrl: 'https://example.com/cloud.dmg', plan: 'free' });
    assert.equal(m.subject, "You're approved for Quorum Free");
    assert.equal(m.plan, 'free');
    assert.match(m.text, /github\.com\/smejkaldesign\/quorum\/releases\/latest/);
    assert.doesNotMatch(m.text, /cloud\.dmg/);
    assert.doesNotMatch(m.text, /6-digit/);
    assert.match(m.html, /open source/);
  });
});

describe('the signup notice to the owner', () => {
  it('names the email in the subject and carries the name, source and note', () => {
    const n = signupNotice({ to: 'owner@example.com', email: 'x@example.com', name: 'Ada', note: 'six calls a day', source: 'hero' });
    assert.equal(n.to, 'owner@example.com');
    assert.equal(n.subject, 'New beta signup: x@example.com');
    assert.match(n.text, /Name: Ada/);
    assert.match(n.text, /From: hero/);
    assert.match(n.text, /Note: six calls a day/);
    assert.doesNotMatch(signupNotice({ to: 'o@example.com', email: 'x@example.com', name: null, note: null, source: 'site' }).text, /Name:|Note:/);
  });
});
