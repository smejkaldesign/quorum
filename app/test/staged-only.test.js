import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DATA_DIR } from '../edition.js';
import { attachments } from '../store/local.js';

const ATTACH = path.join(DATA_DIR, 'attachments');

describe('stagedOnly', () => {
  it('refuses paths that climb out of the attachments folder', () => {
    // dirname(dirname(<ATTACH>/../..)) is <ATTACH> when the path is not resolved first; this must still be refused
    expect(attachments.stagedOnly([`${ATTACH}/../..`])).toEqual([]);
    expect(attachments.stagedOnly([path.join(ATTACH, '..', 'settings.json')])).toEqual([]);
  });
  it('refuses a folder that stage did not make and anything that is not a string list', () => {
    expect(attachments.stagedOnly([path.join(ATTACH, 'not-a-uuid', 'a.txt')])).toEqual([]);
    expect(attachments.stagedOnly('nope')).toEqual([]);
  });
});
