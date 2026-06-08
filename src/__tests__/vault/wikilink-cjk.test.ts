import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { syncVault } from '../../vault/sync.js';
import { getOutgoingLinks } from '../../graph/memory-links.js';

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function mkVault(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v16vault-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf-8');
  }
  return dir;
}

describe('v16 i18n: CJK wiki-link resolution', () => {
  it('a [[CJK-title]] wikilink resolves to the CORRECT note (not collided)', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    // Three notes with CJK-only titles. note-source links to "数据库设计" (database design).
    // The other two CJK-titled notes share NO ASCII chars, so normalizeLinkKey()
    // collapses every title to '' -> the index map collides all of them.
    tmp = mkVault({
      'source.md': '---\ntitle: Source Note\n---\n\nSee [[数据库设计]] for the schema.\n',
      'a.md': '---\ntitle: 缓存策略\n---\n\n关于缓存的笔记。\n', // "cache strategy"
      'b.md': '---\ntitle: 数据库设计\n---\n\n关于数据库设计的笔记。\n', // "database design" - the intended target
      'c.md': '---\ntitle: 部署流程\n---\n\n关于部署的笔记。\n', // "deployment"
    });

    const res = await syncVault(db, embedder, { vaultPath: tmp, force: true });
    expect(res.files_added).toBeGreaterThanOrEqual(4);

    // Find the ids by title.
    const byTitle = (t: string): string => {
      const row = db.prepare('SELECT id FROM memories WHERE title = ? AND parent_id IS NULL').get(t) as { id: string } | undefined;
      if (!row) throw new Error(`note not found: ${t}`);
      return row.id;
    };
    const sourceId = byTitle('Source Note');
    const wantTarget = byTitle('数据库设计'); // b.md

    const links = getOutgoingLinks(db, sourceId).filter((l) => l.relation === 'links_to');
    // The wikilink [[数据库设计]] should resolve to b.md and nothing else.
    const targets = links.map((l) => l.target_memory_id);
    const targetTitles = targets.map((id) => (db.prepare('SELECT title FROM memories WHERE id = ?').get(id) as { title: string }).title);

    // Diagnostics: what did the [[数据库设计]] link actually resolve to?
    expect(
      targets,
      `[[数据库设计]] resolved to ${JSON.stringify(targetTitles)} instead of the intended '数据库设计' note. ` +
        `normalizeLinkKey() strips all non-ASCII so every CJK title collapses to '' and collides.`,
    ).toContain(wantTarget);
    // And it must NOT have linked to the unrelated CJK note (collision).
    expect(targetTitles, 'wikilink leaked to an unrelated CJK note').not.toContain('缓存策略');
    expect(targetTitles, 'wikilink leaked to an unrelated CJK note').not.toContain('部署流程');
  });

  // battle-v16 re-battle WIKILINK-NFC: precomposed (NFC) link vs decomposed (NFD)
  // title (what macOS/editors emit) must resolve — same canonical string.
  it('a [[Café]] (NFC) wikilink resolves to a note titled "Café" stored NFD', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const nfd = 'Café'; // C a f e + combining acute  (NFD)
    const nfc = 'Café'; // C a f é                      (NFC)
    expect(nfd.normalize('NFC')).toBe(nfc); // same canonical title
    tmp = mkVault({
      'source.md': `---\ntitle: Source Note\n---\n\nSee [[${nfc}]] for notes.\n`,
      'target.md': `---\ntitle: ${nfd}\n---\n\nThe cafe note.\n`,
    });
    await syncVault(db, embedder, { vaultPath: tmp, force: true });
    const src = db.prepare("SELECT id FROM memories WHERE title='Source Note' AND parent_id IS NULL").get() as { id: string };
    const tgt = db.prepare('SELECT id FROM memories WHERE title = ? AND parent_id IS NULL').get(nfd) as { id: string };
    const targets = getOutgoingLinks(db, src.id).filter((l) => l.relation === 'links_to').map((l) => l.target_memory_id);
    expect(targets).toContain(tgt.id);
  });

  // battle-v16 re-battle WIKILINK-EMPTYKEY: symbol/emoji-only titles must NOT
  // collide to '' and mis-link. An un-indexable title resolves to NOTHING (a
  // wrong link is data corruption; no link is correct).
  it('an emoji-only [[🚀]] link does NOT leak to an unrelated emoji-titled note', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    tmp = mkVault({
      'source.md': '---\ntitle: Source Note\n---\n\nLaunch: [[🚀]].\n',
      'a-rocket.md': '---\ntitle: 🚀\n---\n\nRocket notes.\n',
      'z-other.md': '---\ntitle: ✨\n---\n\nSparkle notes.\n',
    });
    await syncVault(db, embedder, { vaultPath: tmp, force: true });
    const src = db.prepare("SELECT id FROM memories WHERE title='Source Note' AND parent_id IS NULL").get() as { id: string };
    const other = db.prepare("SELECT id FROM memories WHERE title='✨' AND parent_id IS NULL").get() as { id: string };
    const targets = getOutgoingLinks(db, src.id).filter((l) => l.relation === 'links_to').map((l) => l.target_memory_id);
    // No leak to the unrelated ✨ note (empty-key collision closed).
    expect(targets).not.toContain(other.id);
  });

  // battle-v16 re-battle WIKILINK-NUKTA: a precomposed nukta letter (क़ U+0958,
  // which NFC leaves decomposed as क + U+093C) must stay DISTINCT from its base
  // letter (क) — keeping combining marks in the key prevents a [[क़]] link from
  // mis-resolving to the unrelated क note.
  it('a nukta letter [[क़ नोट]] does NOT mis-resolve to the base-letter क note', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    tmp = mkVault({
      '0-source.md': '---\ntitle: Source Note\n---\n\nSee [[क़ नोट]].\n',
      '1-qa.md': '---\ntitle: क़ नोट\n---\n\nqa note.\n',
      '2-ka.md': '---\ntitle: क नोट\n---\n\nka note.\n',
    });
    await syncVault(db, embedder, { vaultPath: tmp, force: true });
    const src = db.prepare("SELECT id FROM memories WHERE title='Source Note' AND parent_id IS NULL").get() as { id: string };
    const qa = db.prepare("SELECT id FROM memories WHERE title='क़ नोट' AND parent_id IS NULL").get() as { id: string };
    const ka = db.prepare("SELECT id FROM memories WHERE title='क नोट' AND parent_id IS NULL").get() as { id: string };
    const targets = getOutgoingLinks(db, src.id).filter((l) => l.relation === 'links_to').map((l) => l.target_memory_id);
    expect(targets).toContain(qa.id);      // resolves to the intended qa note
    expect(targets).not.toContain(ka.id);  // not the unrelated base-letter note
  });

  // battle-v16 round-4 WIKILINK-VS16: a wikilink differing only by an invisible
  // emoji variation selector (❤️ with VS16 vs ❤ without) must still resolve —
  // variation selectors are presentation-only and stripped from the key.
  it('resolves a wikilink that differs only by an emoji variation selector', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const withVs = 'Favorites ❤️'; // ❤️ (VS16)
    const noVs = 'Favorites ❤';          // ❤  (no selector)
    tmp = mkVault({
      'source.md': `---\ntitle: Linker\n---\n\nSee [[${noVs}]].\n`,
      'target.md': `---\ntitle: ${withVs}\n---\n\nFav notes.\n`,
    });
    await syncVault(db, embedder, { vaultPath: tmp, force: true });
    const src = db.prepare("SELECT id FROM memories WHERE title='Linker' AND parent_id IS NULL").get() as { id: string };
    const tgt = db.prepare('SELECT id FROM memories WHERE title = ? AND parent_id IS NULL').get(withVs) as { id: string };
    const targets = getOutgoingLinks(db, src.id).filter((l) => l.relation === 'links_to').map((l) => l.target_memory_id);
    expect(targets).toContain(tgt.id);
  });

  // battle-v16 round-5 VS-IVS-1: Ideographic Variation Selectors (U+E0100+) are
  // IDENTITY-bearing (distinct registered CJK glyph variants), unlike emoji
  // presentation selectors — they must NOT be stripped, so two titles differing
  // only by an IVS stay distinct and a [[葛︀]] link does not mis-resolve.
  it('keeps Ideographic Variation Selectors distinct (no cross-variant mis-link)', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const a = '葛\u{E0100}'; // variant A
    const b = '葛\u{E0101}'; // variant B (same base, different registered glyph)
    tmp = mkVault({
      'src.md': `---\ntitle: Linker\n---\n\nSee [[${a}]].\n`,
      'a.md': `---\ntitle: ${a}\n---\n\nvariant A.\n`,
      'b.md': `---\ntitle: ${b}\n---\n\nvariant B.\n`,
    });
    await syncVault(db, embedder, { vaultPath: tmp, force: true });
    const src = db.prepare("SELECT id FROM memories WHERE title='Linker' AND parent_id IS NULL").get() as { id: string };
    const idA = db.prepare('SELECT id FROM memories WHERE title = ? AND parent_id IS NULL').get(a) as { id: string };
    const idB = db.prepare('SELECT id FROM memories WHERE title = ? AND parent_id IS NULL').get(b) as { id: string };
    const targets = getOutgoingLinks(db, src.id).filter((l) => l.relation === 'links_to').map((l) => l.target_memory_id);
    expect(targets).toContain(idA.id);     // resolves to the intended variant A
    expect(targets).not.toContain(idB.id); // not the distinct variant B
  });
});
