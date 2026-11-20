import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ANYWAY_LABEL, CHANGED_TEXT, WRITING_TEXT, WritingStatus, anywayLabel, anywayOffered, focusOnGenerate, prepEmptyText, regenerateLabel } from '../src/meetingBriefView.tsx';

const BRIEF = { prep: '- Ask about the portfolio. (invite)', what: 'An interview.', who: 'Invited: Jane Doe.', how: 'Nothing found.', sources: 'Based on limited history: the invite and 2 related notes.', oneOff: true };

describe('meeting prep: Generate anyways', () => {
  it('shows the button below the Not recurring yet message under the threshold', () => {
    const few = { status: 'few', anyway: true, min: 3, brief: null };
    expect(anywayOffered(few)).toBe(true);
    expect(prepEmptyText(few)).toMatch(/^Not recurring yet\. After 3 or more meetings/);
    expect(prepEmptyText(few)).toContain(ANYWAY_LABEL);
    expect(ANYWAY_LABEL).toBe('Generate anyways');
    // a failed try offers it again
    expect(anywayOffered({ status: 'failed', anyway: true, brief: null })).toBe(true);
  });
  it('never shows with the meeting-prep-anyway flag off', () => {
    expect(anywayOffered({ status: 'few', anyway: false, brief: null })).toBe(false);
    expect(prepEmptyText({ status: 'few', anyway: false, min: 3 })).not.toContain(ANYWAY_LABEL);
  });
  it('never shows at 3 or more past meetings, where the series brief answers without anyway', () => {
    for (const status of ['ready', 'stale', 'no-model', 'failed']) expect(anywayOffered({ status, brief: null })).toBe(false);
    expect(anywayOffered({ status: 'ready', brief: { ...BRIEF, oneOff: undefined } })).toBe(false);
  });
  it('hides once a brief is written, which says it came from limited history', () => {
    expect(anywayOffered({ status: 'ready', anyway: true, brief: BRIEF })).toBe(false);
    expect(BRIEF.sources).toMatch(/^Based on limited history/);
  });
  it('says plainly when there is nothing to build from, and shows the no-model message', () => {
    expect(anywayOffered({ status: 'empty', anyway: true, brief: null })).toBe(false);
    expect(prepEmptyText({ status: 'empty', anyway: true })).toBe('There is nothing to build prep notes from yet. This meeting has no earlier meetings, no other invitees, no description and no related notes.');
    expect(prepEmptyText({ status: 'no-model', anyway: true })).toBe("Choose a model in Settings and Quorum writes prep notes from this meeting's past notes.");
  });
  it('marks a kept brief whose invite changed as out of date, with Update in place of Regenerate', () => {
    const changed = { status: 'ready', anyway: true, brief: BRIEF, changed: true };
    expect(anywayOffered(changed)).toBe(false);
    expect(regenerateLabel(changed, false)).toBe('Update');
    expect(regenerateLabel({ changed: false }, false)).toBe('Regenerate');
    expect(regenerateLabel(changed, true)).toBe('Writing…');
    expect(CHANGED_TEXT).toContain('Update');
  });
  it('moves focus to the section heading on Generate anyways and announces the run', () => {
    expect(focusOnGenerate(false, 'prep')).toBe('prep');
    expect(focusOnGenerate(false, 'about')).toBe('about');
    expect(focusOnGenerate(true, 'prep')).toBeNull();
    expect(renderToStaticMarkup(createElement(WritingStatus))).toBe(`<p class="sr-only" role="status">${WRITING_TEXT}</p>`);
    expect(WRITING_TEXT).toBe('Writing prep notes…');
  });
  it('shows the Choose a model message in place of the button when no model source is set', () => {
    const noModel = { status: 'no-model', anyway: true, brief: null };
    expect(anywayOffered(noModel)).toBe(false);
    expect(prepEmptyText(noModel)).toMatch(/^Choose a model in Settings/);
  });
  it('labels the button Try again after a failed run, matching the line above it', () => {
    const failed = { status: 'failed', anyway: true, brief: null };
    expect(anywayOffered(failed)).toBe(true);
    expect(anywayLabel(failed)).toBe('Try again');
    expect(prepEmptyText(failed)).toBe('Quorum could not write prep notes this time. Try again.');
    expect(anywayLabel({ status: 'few' })).toBe(ANYWAY_LABEL);
  });
});
