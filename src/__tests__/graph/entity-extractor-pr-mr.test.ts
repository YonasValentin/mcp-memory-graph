/**
 * battle-v7 M5 — a PR/MR reference must be a pull_request only, never ALSO a
 * work_item.
 *
 * THE BUG (correctness): WORK_ITEM_RE (/[A-Z][A-Z0-9]{1,9}-\d{2,}/) also matches
 * "PR-146" / "MR-209", and the dedup key is `type:name`, so near a tracker
 * keyword the same reference was emitted as BOTH a work_item anchor AND a
 * pull_request anchor — a spurious, mislabeled graph node. (The existing
 * anchor-entities test uses a name→type Map, where pull_request — added last —
 * masks the duplicate work_item.)
 *
 * THE FIX: skip the PR/MR project codes in the work_item pass; they are handled
 * by the dedicated pull_request extractor.
 */
import { describe, it, expect } from 'vitest';
import { extractEntitiesRegex } from '../../graph/entity-extractor.js';

describe('extractEntitiesRegex — M5: PR/MR is pull_request, not work_item', () => {
  it('PR-146 near a tracker keyword is ONLY pull_request', () => {
    const ents = extractEntitiesRegex('Closed the ticket via PR-146 today');
    expect(ents.filter((e) => e.name === 'PR-146').map((e) => e.type)).toEqual(['pull_request']);
    expect(ents.some((e) => e.type === 'work_item' && e.name === 'PR-146')).toBe(false);
  });

  it('MR-209 near a tracker keyword is ONLY pull_request', () => {
    const ents = extractEntitiesRegex('the issue was resolved when MR-209 merged');
    expect(ents.some((e) => e.type === 'work_item' && e.name === 'MR-209')).toBe(false);
    expect(ents.some((e) => e.type === 'pull_request' && e.name === 'MR-209')).toBe(true);
  });

  it('a genuine tracker key is still a work_item (no regression)', () => {
    const ents = extractEntitiesRegex('Fixed in ticket PROJ-203 last week');
    expect(ents.some((e) => e.type === 'work_item' && e.name === 'PROJ-203')).toBe(true);
  });
});
