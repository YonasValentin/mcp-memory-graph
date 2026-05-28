# Research 02 — Obsidian as the Conceptual Model for a "Revolutionary Vault"

**Question:** What makes Obsidian beloved, and how does each beloved capability map onto an
agent-facing MCP memory server so we can deliver the same "magic" programmatically?

**Method:** Primary sources scraped/fetched on 2026-05-29 — obsidian.md, the Obsidian Help
site, the Obsidian developer docs (TypeScript API), the JSON Canvas open spec, Andy
Matuschak's evergreen-notes garden, the Dataview docs, and Nick Milo's LYT writeups. Real
URLs captured inline and in the citations list.

**Grounding:** Mappings target the *actual* mcp-memory-server surface as it exists today —
`src/tools/*` (store, search, related, graph, extract-entities, vault-sync, export, import,
versions, consolidate, condense), `src/graph/*` (entity-extractor, entity-store,
conflict-resolver), `src/vault/*` (parser, scanner, sync), `src/api/routes.ts`
(`/api/graph` D3 endpoint), and the SQLite + sqlite-vec + local-embedder data plane with
`scope`/`namespace`/`access_level`/`memory_access_log`.

---

## 0. The One-Sentence Thesis

Obsidian is beloved because it makes a pile of plain-text files behave like a living mind:
**you own the substrate (local-first, plain markdown, open formats), the connections are
first-class (wikilinks → backlinks → graph), and the tool gets out of the way of thinking
(daily capture, spatial canvas, infinite plugins).** Its marketing frame is *"Writing is
telepathy"* — ideas travel across time and space from a sending mind to a receiving mind. A
memory server for agents is exactly that telepathy channel: one agent (or one session)
*sends* an idea into durable storage; a future agent *receives* it. Obsidian is the proof
that the magic lives in **ownership + connection + frictionlessness**, not in any single
feature. That is the entire design brief for the memory server.

The three pillars from the homepage are worth quoting verbatim because they double as our
product principles:

> **Your thoughts are yours.** Obsidian stores notes privately on your device... No one
> else can read them, not even us.
> **Your mind is unique.** With thousands of plugins and themes, you can shape Obsidian to
> fit your way of thinking.
> **Your knowledge should last.** Obsidian uses open file formats, so you're never locked
> in. You own your data for the long term.
> — [obsidian.md](https://obsidian.md/)

For an agent memory server these translate to: **local-first SQLite + markdown export**
(thoughts are yours), **MCP tools + open schema** (shape it to the agent's workflow), and
**plain-markdown vault sync + `memory_export`** (knowledge should last, no lock-in).

---

## 1. The Vault Concept — Local-First, Plain Markdown, File Ownership, Open Formats

### What Obsidian does
A *vault* is just a folder of plain `.md` files on disk. No proprietary database, no cloud
dependency, no account required. Notes are private and offline-first ("access them quickly,
even offline. No one else can read them, not even us"). Everything — including
configuration, themes, and plugin state — lives in the vault folder. Because the format is
open markdown + YAML, you are "never locked in" and "own your data for the long term."

The deep insight: **the file is the unit of ownership and the unit of portability at the
same time.** You can `grep` a vault, `git` a vault, `rsync` a vault, open it in any editor
20 years from now. Obsidian is a *viewer/editor* over files it doesn't own. That humility is
why people trust it with a lifetime of notes.

### Map onto the memory server
- **Memory record ↔ markdown note.** Each memory should have a canonical, human-readable
  markdown representation (the vault layer already does this via `src/vault/parser.ts` +
  `scanner.ts` + `sync.ts`). The SQLite row is the *index*; the markdown file is the
  *source of truth the user can own*. This mirrors Obsidian exactly: DB = MetadataCache,
  files = vault. Treating SQLite as a rebuildable cache over an exportable markdown vault is
  the single most important architectural commitment for "revolutionary vault" credibility.
- **Local-first as a feature, not a fallback.** The server already binds to loopback by
  default and runs the embedder locally (per HANDOVER/DATA-HANDLING). Lean into this in
  positioning: "your agent's memory never leaves your machine unless you choose remote."
  This is the *exact* trust posture that made Obsidian beloved over Notion/Roam.
- **No lock-in = `memory_export` is sacred.** `src/tools/export.ts` is the equivalent of
  "open file formats." Guarantee a round-trip: `memory_export` → markdown-with-frontmatter
  → `memory_import` (`src/tools/import.ts`) with zero loss. If an agent's whole memory can
  be dumped to a folder of `.md` and re-ingested, you have Obsidian's ownership guarantee.
- **`scope`/`namespace` ↔ vaults/folders.** Obsidian users keep multiple vaults (work,
  personal, project). The server's `scope` (global/project) + `namespace` is the
  programmatic analogue. Per-agent or per-project namespaces are "vaults"; treat them as
  first-class, independently exportable units.

---

## 2. `[[Wikilinks]]` + Backlinks + Unresolved Links

### What Obsidian does
**Wikilink syntax** (the default) is the core gesture:
- Basic link: `[[Three laws of motion]]`
- Alias / display text: `[[Three laws of motion|Newton's laws]]`
- Heading link: `[[About Obsidian#Links are first-class citizens]]`, nested
  `[[Help#Questions#Report bugs]]`
- Block reference: `[[2023-01-01#^37066d]]` (a `^id` on a paragraph/list/quote)
- Embed: prefix with `!` → `![[note]]` embeds the linked content inline
- Auto-update on rename: rename a note and every `[[link]]` to it is rewritten

**Backlinks** are the inverse index, surfaced automatically in a side pane and optionally
inline in the document. Two flavors:
- **Linked mentions** — notes that contain an explicit `[[link]]` to the current note.
- **Unlinked mentions** — notes that contain the *text* of the current note's name but
  haven't linked it yet, with a one-click "link" affordance.

**Unresolved links** are `[[links]]` whose target note doesn't exist yet. Obsidian keeps
them as ghost nodes (faded in the graph) — they are *promissory notes*, a to-do list of
ideas you've gestured at but not yet written. The autocomplete (`[[thin…` →
"I **thin**k therefore I am", "**Thin**king, Fast and Slow") shows links forming as you
type. Crucially, the help docs confirm Obsidian programmatically tracks both:
`MetadataCache.resolvedLinks` and `MetadataCache.unresolvedLinks`.

### Why it's magic
Linking is a *cheap, in-the-flow gesture* that compounds. You don't file things into
folders; you connect them, and the connections become navigation, structure, and surprise
later. Backlinks mean every connection is bidirectional for free — you discover that a note
is relevant to a context you weren't thinking about when you wrote it. Unlinked mentions turn
the system into a co-pilot that proposes connections you didn't make explicitly.

### Map onto the memory server
| Obsidian | Memory server |
|---|---|
| `[[wikilink]]` typed in-flow | **Entity references inside memory content** — `src/graph/entity-extractor.ts` already pulls project names, people, tools, patterns. Treat each extracted entity as an implicit `[[wikilink]]`. |
| Linked mentions (backlinks) | **Entity co-occurrence edges** — two memories mentioning the same entity are mutually backlinked. `memory_graph`/`src/tools/related.ts` is the backlinks pane. Surface "memories that reference entity X" on every `memory_get`. |
| **Unlinked mentions** (the killer feature) | **Embedding-similar-but-not-yet-linked memories.** This is the agent-facing superpower: when storing/reading a memory, run KNN (sqlite-vec) and surface "you've never linked these but they're semantically about the same thing." This is *unlinked mentions, automated by vectors instead of string-matching* — strictly more powerful than Obsidian. |
| Unresolved links (ghost nodes) | **Entities mentioned but with no rich memory yet** = the agent's open questions / knowledge gaps. `entity-store.ts` can hold an entity with zero or thin backing memories. Expose these as "memory gaps" so an agent knows what it has gestured at but not learned. This is a *to-research list for the agent.* |
| Auto-update links on rename | **Entity-alias / merge on conflict** — `src/graph/conflict-resolver.ts` is the rename-propagation analogue. When two entities are merged ("SalesPlan" == "Sales Plan"), all co-occurrence edges follow. |
| Aliases `[[X|Y]]` | **Entity aliases** — store alternate names so "Postgres"/"PostgreSQL" resolve to one node. |
| Block reference `^id` | **Memory-chunk addressing** — `src/chunking/*` already splits memories; expose stable chunk IDs so an agent can cite "memory#chunk^3" precisely. |

**Design takeaway:** the most defensible feature we can ship is **automated unlinked
mentions for agents** — surface latent connections (vector + entity co-occurrence) at
read/write time, so the agent's memory keeps *proposing* relevant prior knowledge without
the agent ever having to explicitly link anything.

---

## 3. The Graph View — Local + Global

### What Obsidian does
- **Nodes = notes** (optionally also tags and attachments as nodes). **Edges = internal
  links.** Node size grows with in-degree (how many notes reference it) — instant visual
  PageRank.
- **Global graph** = the whole vault; **local graph** = only what's connected to the active
  note, with an adjustable **depth** slider (1 hop, 2 hops…).
- **Filters:** search-based filtering; toggles for tags, attachments, **orphans** (unlinked
  notes), and **non-existent/unresolved** notes (ghost nodes).
- **Groups:** define a search query → assign a color. Visual clustering by topic/status.
- **Display:** arrows, text fade, node/link size, and a **time-lapse animation** of notes
  appearing in creation order.
- **Forces:** four sliders — **center force** (compactness), **repel force** (separation),
  **link force** (tension), **link distance** (edge length).

### What it reveals
Connection density, **orphans** (notes you never linked = probably mis-filed or forgotten),
hub notes (your real centers of gravity), clusters (emergent topics you didn't plan), and
unresolved ghosts (gaps). The graph is less a navigation tool and more a **mirror of the
shape of your thinking** — people report seeing structure they didn't know they had.

### Map onto the memory server
- **We already have the graph endpoint.** `src/api/routes.ts` exposes `/api/graph` and there
  is a D3 graph in the picture (per the task brief + IMPLEMENTATION.md notes on the SQL-based
  graph endpoint). The mapping is essentially 1:1:
  - **Nodes = memories or entities; edges = co-occurrence / vector-similarity / shared
    namespace.** Node size = importance_score or in-degree.
  - **Local graph = `memory_related` / `memory_graph` for one memory or entity, with a
    depth param.** Global graph = full `/api/graph` render.
  - **Groups = color by `namespace`, `document_type`, or `scope`** (we already select these
    columns in the graph SQL). This is Obsidian's "color a search query" feature for free.
  - **Orphan detection = memories with no entity edges and low vector neighbors.** Surfacing
    orphans tells the agent "this knowledge is islanded — likely stale or mis-scoped."
  - **Time-lapse = replay by `created_at`** to watch how the agent's knowledge grew over a
    project. A genuinely novel agent-debugging view: *when did the agent learn X?*
- **Agent-facing twist:** the graph for an agent isn't primarily for human gazing — it's a
  **retrieval-planning structure**. Expose graph traversal as a tool (`memory_graph` with
  depth) so the agent can do multi-hop reasoning ("what's 2 hops from entity SalesPlan?")
  instead of only flat KNN. That's the graph view turned into an *API the model calls.*

---

## 4. Canvas — Infinite Spatial Thinking

### What Obsidian does
Canvas is a core plugin: an **infinite spatial board** where cards can be text, embedded
vault notes, media (images/audio/PDF), web pages, or whole folders. Cards connect with
**directed, labeled, colorable edges**; related cards group into named groups; you can pan,
zoom, zoom-to-fit. Critically, a canvas saves as a **`.canvas` file in the open JSON Canvas
format** ([jsoncanvas.org](https://jsoncanvas.org/spec/1.0/)) — another open, ownable
artifact, not a proprietary blob.

**JSON Canvas 1.0 spec (the reusable bit):**
- Top level: `{ "nodes": [...], "edges": [...] }`
- Node: required `id, type, x, y, width, height`; optional `color`. Types:
  `text` (`text` markdown), `file` (`file` path + optional `subpath`), `link` (`url`),
  `group` (`label`, `background`, `backgroundStyle`).
- Edge: required `id, fromNode, toNode`; optional `fromSide/toSide` (top/right/bottom/left),
  `fromEnd/toEnd` (none/arrow), `color`, `label`.
- Colors: hex, or presets `1`–`6` (red/orange/yellow/green/cyan/purple), with exact values
  intentionally left to the app.

### Why it's magic
Spatial position *is* meaning. Canvas lets you think with proximity, regions, and arrows
before you have words for the structure — it captures pre-verbal organization. And because
it's an open format, a canvas is portable and machine-readable.

### Map onto the memory server
- **Adopt JSON Canvas as an *output format*, not just a viewer.** A killer feature:
  `memory_graph` (or a new `memory_canvas` tool) emits a valid `.canvas` file from a query —
  e.g. "lay out everything in namespace=edc as a JSON Canvas." The user opens it *in their
  real Obsidian* and sees the agent's memory as a spatial map they can edit. This is the
  bridge that makes the server feel like Obsidian rather than merely Obsidian-inspired:
  **the agent's memory becomes a first-class Obsidian artifact.** Low effort, high wow —
  the spec is tiny (above) and we already have nodes/edges from the graph layer.
- **Spatial memory map for agents.** Because edges carry `label` + direction, we can encode
  *typed relationships* ("X depends-on Y", "decision supersedes decision") — richer than
  Obsidian's untyped links. The agent emits a reasoning map; the human reads it spatially.
- **Round-trip:** ingest a hand-authored `.canvas` (via `vault/parser.ts`) so a human can
  *arrange* the agent's knowledge spatially and have that structure flow back as edges. The
  human teaches the agent structure by moving cards.

---

## 5. The Plugin Ecosystem + Open API

### What Obsidian does
"Thousands of plugins and our open API." A community plugin is a TypeScript module extending
a `Plugin` base class with an `onload()`/`onunload()` lifecycle. The API surface that
matters for us:
- **Vault API** — read/write/watch files (the data plane).
- **MetadataCache** — the link/graph brain. Confirmed surface:
  `resolvedLinks` (maps each source path → `{destPath: count}`), `unresolvedLinks` (same for
  ghost targets), `getFileCache(file)` / `getCache(path)` returning frontmatter, links,
  embeds, tags, headings, blocks; resolution helpers `getFirstLinkpathDest`,
  `fileToLinktext`; and events `changed`, `resolve`, `resolved`, `deleted`. **This is
  literally a programmatic graph API** — the thing we are building, Obsidian already exposes.
- **Workspace, Commands, Settings, Views, Editor (CodeMirror) extensions, Events.**

### Why it's magic
The open API turns Obsidian from an app into a *platform*. Power users mold it
(Dataview, Tasks, Kanban, Calendar, Templater) so it "fits your way of thinking." The vendor
ships a stable core; the community ships the long tail. That's why no two vaults are alike
and why people are deeply invested.

### Map onto the memory server
- **MCP tools ARE the plugin API.** Each tool in `src/tools/*` is a "plugin" the agent can
  invoke. The MCP protocol is our open API. To get the *ecosystem* effect:
  - Keep a **small, stable, documented core tool set** (store/search/related/graph/get) and
    let everything else compose on top — mirror Obsidian's "core plugins vs community
    plugins" split.
  - Publish the tool schemas (`src/schemas/*`) as the public contract, the way Obsidian
    publishes its TypeScript API. Stability of this surface is what lets third parties build.
- **Steal MetadataCache wholesale as the internal abstraction.** Build an internal
  `MemoryCache` that exposes `resolvedLinks`/`unresolvedLinks`-style maps over the entity
  graph, plus `changed`/`resolved` events. Then `/api/graph`, `memory_related`, and any
  future tool all read from one coherent link index — exactly how every Obsidian plugin
  reads from one MetadataCache. This is the cleanest architecture borrow available.
- **"Memory tool extensions" = the plugin store.** Allow registering domain tools
  (e.g. `extract-learnings.ts`, `condense.ts`, `consolidate.ts` are already
  domain-flavored). A plugin manifest (`src/tools/manifest.ts` exists) is the analogue of
  Obsidian's community plugin registry.

---

## 6. Obsidian Sync — E2E Encrypted, Version History, Selective Sync, Shared Vaults

### What Obsidian does
- **End-to-end encryption**, AES-256; "no one else can read them, not even us."
- **Offline-first**: work offline, auto-merge on reconnect.
- **Version history** per note (Standard = 1 month, Plus = 12 months), with **diffs between
  revisions**, **snapshots**, **deleted-file recovery**, and a **sync activity** log.
- **Selective sync**: excluded folders; per-type toggles (images/audio/video/PDF/other);
  and **settings sync** (hotkeys, prefs, themes, snippets, plugin enable-state, appearance).
- **Shared vaults**: real-time team collaboration on shared files "without compromising your
  private data."

### Map onto the memory server
- **Version history — we already have `src/tools/versions.ts`.** Make it Obsidian-grade:
  per-memory revision list + **diff between revisions** + restore. An agent rewriting a
  memory should never destroy the prior version; the diff view is how a human audits what
  the agent changed and why. This is a trust feature, not a convenience.
- **E2E / privacy posture.** Our story is *local-first by default* (loopback bind, local
  embedder, FileVault/LUKS at rest per DATA-HANDLING). For remote, the bearer-token +
  reverse-proxy TLS boundary is the analogue of Obsidian's encryption. Frame it the same way:
  "your agent's memories are yours; the operator never reads them in transit."
- **Selective sync ↔ scope/namespace + `access_level`.** Choosing which folders sync maps to
  choosing which `namespace`s replicate to a remote/shared instance, and `access_level`
  governs what's shareable. Excluded folders ↔ private namespaces that never leave the box.
- **Shared vaults ↔ a shared/team namespace.** A team of agents (or a human + their agents)
  reading/writing a common namespace = Obsidian's shared vault. The `conflict-resolver.ts`
  is our merge engine. The `memory_access_log` is our "sync activity" log + audit trail.
- **Snapshots / deleted-file recovery ↔ soft-delete + export.** `memory_delete` should
  tombstone, not hard-delete, with `memory_export` as the recovery path — Obsidian's
  deleted-file recovery.

---

## 7. Obsidian Publish — Instant Web Wiki / Digital Garden

### What Obsidian does
One-click turn a (subset of a) vault into a hosted website: a "wiki, knowledge base,
documentation, or digital garden." Features named in the docs: **hover previews**,
**graph view** on the public site, **stacked pages** (links open in horizontal panes),
**backlinks**, **search**, **custom domain**, **customizable theme** (CSS + JS),
**password protection** (multiple passwords), **first-class SEO**, privacy-friendly analytics
(Plausible/Fathom), 4GB hosting, 100% Lighthouse accessibility. **Selective publishing** —
you choose which notes go public; unpublished `[[links]]` simply don't resolve on the site.

### Why it's magic
Your private thinking substrate and your public output are *the same notes*. No copy-paste,
no separate CMS. The graph and backlinks come along, so the published garden is *navigable
the way you think*, not flattened into a blog. "Digital garden" culture grew directly out of
this.

### Map onto the memory server
- **Shareable memory wiki = the highest-leverage net-new feature.** Render a read-only web
  view of a chosen `namespace`/`scope` — memories as pages, entities as wiki terms, the D3
  graph as the public graph view, co-occurrence as backlinks, vector-search as site search.
  This turns "the agent's memory" into a browsable, linkable knowledge base a whole team can
  read. We already have the graph endpoint + search; Publish is mostly a read-only front end
  + access gating over existing data.
- **Selective publish ↔ `access_level` + namespace allow-list.** Exactly Obsidian's
  selective publishing: only memories at/below a chosen `access_level` in an allow-listed
  namespace are exposed; references to non-published memories degrade gracefully (ghost
  links). The `access_level` field already exists per DATA-HANDLING.
- **Custom domain + password = the homelab story.** This deploys cleanly behind the existing
  Cloudflare Tunnel (mcp.yonasvalentin.dk pattern) with bearer/password gating — Publish's
  "password protection" maps directly.
- **Hover previews + stacked pages** are pure UX borrows for the web view: hovering a memory
  link shows a popover; clicking opens a new stacked pane so you keep context while drilling.
  These two interactions are *why* Publish feels like a brain and not a doc dump.

---

## 8. Bases / Properties — Structured Metadata as a Database

### What Obsidian does
**Properties** = typed YAML frontmatter on a note: text, list, number, checkbox, date,
date-and-time. Special ones: `tags`, `aliases`, `cssclasses`. A `date` property can link to
its daily note. Properties make notes *queryable* via dedicated search syntax and a
**Properties view** for bulk rename/management across the vault.

**Bases** (core plugin) turns a folder of property-bearing notes into a **native database**:
views = **table** (rows = files, columns = properties), **cards** (gallery), **list**,
**map** (pins). It supports **filters, sorting, grouping, and formula properties**
(computed columns). Saved as a `.base` file or embedded as a code block in a note. It is the
official, native answer to what Dataview (community) pioneered.

### Map onto the memory server
- **Properties ↔ our memory metadata columns + `metadata` JSON.** We already store `scope`,
  `namespace`, `document_type`, `tags`, `importance_score`, `access_level`, `expires_at`,
  timestamps. That's a properties schema. Standardize it as the "frontmatter" of each
  memory's markdown representation so the vault export carries typed properties Obsidian can
  read natively (round-trip into a real Bases view).
- **Bases ↔ structured `memory_list`/query views.** Provide an agent tool that returns
  memories as a **filterable, sortable, groupable table** by property (e.g. "all `decision`
  memories in namespace=signal, grouped by month, sorted by importance"). This is Bases for
  agents — structured retrieval that complements fuzzy vector search.
- **Formula properties ↔ computed memory signals.** `importance_score`, recency decay,
  access-count (from `memory_access_log`) are computed columns. Surfacing them like Bases
  formulas lets the agent reason over *derived* metadata, not just stored fields.

---

## 9. Dataview-Style Queries

### What Obsidian does
Dataview (the most-loved community plugin) is "a live index and query engine over your
personal knowledge base." You add data via **YAML frontmatter** or **inline fields**
(`[key:: value]` mid-text), then query with **DQL**. Query types: **TABLE** (columns of
field data), **LIST** (bullets), **TASK** (interactive checkboxes), **CALENDAR** (dots on
dates). Grammar: `<TYPE> <fields> FROM <source> <DATA-COMMAND> <expr> …` (WHERE, SORT,
GROUP BY, LIMIT, FLATTEN). Also runnable as inline DQL or JavaScript queries.

### Why it's magic
Your notes stop being static text and become a **queryable dataset that updates itself**.
"All open tasks tagged #project from this folder, sorted by due date" is a live view, not a
manual list. It rewards adding metadata because the metadata immediately pays off in queries.

### Map onto the memory server
- **A query language for memory.** Beyond KNN search, expose a structured query surface over
  memory properties — the agent's Dataview. `FROM namespace` + `WHERE document_type =
  'decision' AND importance_score > 0.7` + `SORT created_at DESC` `LIMIT 20`. `src/search/*`
  + the graph SQL are the engine; we just need a stable, model-friendly query grammar
  (likely a JSON DSL, not text DQL, since the caller is an LLM).
- **Inline fields ↔ entity extraction.** Dataview's `[key:: value]` mid-text is exactly what
  `entity-extractor.ts` does automatically — pull structured fields out of prose. We get
  inline fields *for free, without the user typing them.*
- **TASK queries ↔ agent to-dos.** Memories of type "todo"/"open-question"/unresolved
  entities = a live task list the agent queries each session. This is how the agent
  "remembers what it was supposed to do next" — a genuinely agent-native Dataview use.
- **Live, not snapshot.** The lesson: queries should reflect current state every call, so
  the agent never reasons over stale lists. Our SQL-backed approach already gives this.

---

## 10. Daily Notes + Templates

### What Obsidian does
**Daily Notes** (core plugin): "opens a note based on today's date, or creates it if it
doesn't exist," default name `YYYY-MM-DD`, configurable location, and date-format paths can
auto-nest into `YYYY/MMMM/` subfolders. **Templates**: a designated template file inserted
on creation, with placeholders like `{{date:YYYY-MM-DD}}` and `{{date}}`. Daily notes serve
as "journals, to-do lists, or daily logs." When enabled, date properties auto-link to the
matching daily note.

### Why it's magic
Daily notes remove the "where do I put this?" friction entirely — there's always an obvious
inbox for today. Templates make every entry consistently structured without thinking. It's a
*capture habit engine*: low-friction in, structure for free.

### Map onto the memory server
- **Session notes ↔ daily notes.** An agent's natural period is the **session/conversation**,
  not the calendar day. Auto-create a "session memory" per conversation
  (`session-YYYY-MM-DD-<id>`) that captures what was learned — the agent's daily note. This
  is the always-there inbox: the agent never has to decide *where* to record a takeaway.
- **Templates ↔ memory schemas per `document_type`.** A "decision" memory, a "learning"
  memory (cf. `extract-learnings.ts`), a "bug-fix" memory each get a template/schema with
  required properties, so stored memories are structurally consistent and therefore
  queryable (§9) and groupable (§8). Templates are what make Dataview/Bases pay off — same
  here: enforce shape at write time.
- **Capture-habit framing.** The product win is making `memory_store` so frictionless and
  auto-structured that agents record by default, the way daily notes make humans journal by
  default. `extract-entities`/`extract-learnings` running automatically on store = templates
  filling themselves in.

---

## 11. The "Second Brain" / Zettelkasten / Evergreen-Notes Philosophy

### The ideas
- **"Writing is telepathy"** (Stephen King, the obsidian.md hero copy): ideas travel from a
  *sending place* to a *receiving place* across time and space — "a meeting of the minds."
  This is the emotional core Obsidian sells.
- **Zettelkasten** (Luhmann's slip-box): atomic notes, each with an address, densely
  cross-referenced, so the box becomes a "communication partner" that surprises you. Modern
  framing splits notes into **fleeting / literature / permanent / structure** notes.
- **Andy Matuschak's Evergreen Notes** — notes "written and organized to evolve, contribute,
  and accumulate over time, across projects," because "what matters is *better thinking*,"
  not better notes. Five principles (verbatim titles):
  1. *Evergreen notes should be atomic.*
  2. *Evergreen notes should be concept-oriented.*
  3. *Evergreen notes should be densely linked.*
  4. *Prefer associative ontologies to hierarchical taxonomies.*
  5. *Write notes for yourself by default, disregarding audience.*
- **LYT / Maps of Content** (Nick Milo): a **MOC** is a note whose body is mostly links to
  other notes — it "maps the contents" of a cluster. LYT prizes **emergence over hierarchy**
  / **"Idea Emergence"**: structure should *surface from links*, not be imposed by folders.

### Map onto the memory server (this is the product soul)
- **"Writing is telepathy" is the agent-memory thesis.** Sending place = the agent/session
  that calls `memory_store`. Receiving place = a future agent/session that calls
  `memory_search`. The memory server *is* the telepathy channel between minds separated by
  time (and possibly between different agents). Adopt this as the literal product narrative:
  **"Give your agents telepathy across time."**
- **Atomic ↔ chunking + one-idea memories.** `src/chunking/*` and a norm of one concept per
  memory mirror "notes should be atomic" — atomic units link and recombine better, which is
  exactly what improves vector retrieval and graph density.
- **Concept-oriented ↔ entity-centric storage.** Organize the graph around *concepts/
  entities* (entity-store), not around *sources/sessions* — matching "concept-oriented" and
  "associative over hierarchical." This argues *against* a deep folder/namespace hierarchy as
  the primary structure and *for* the entity-link graph as the spine. (Namespaces are vaults,
  not taxonomies.)
- **Densely linked ↔ make linking automatic.** Humans must work to densely link; our agent
  memory can do it *automatically* via entity co-occurrence + vector neighbors at write time
  (§2). We can hit "densely linked" by default — the hardest Zettelkasten discipline becomes
  a free property of the system.
- **Associative over hierarchical ↔ emergent clusters in the graph.** Don't force memories
  into a tree. Let topics emerge as graph clusters (§3) — this is LYT's "Idea Emergence,"
  and for an agent it means relevant memory surfaces by association, not by remembering a
  path. MOCs map to **auto-generated namespace/topic summary memories** (cf.
  `consolidate.ts`/`condense.ts`) — a memory whose body links the cluster it summarizes.
- **Accumulate/develop over time ↔ versions + consolidation.** Evergreen notes get *revised*,
  not appended-and-abandoned. `memory_update` + `versions.ts` + `consolidate.ts` are the
  mechanism: memories should be *refined* as the agent learns more, with history preserved.
  This is the difference between a log (write-once) and a brain (continuously rewritten).
- **Write for yourself ↔ write for the future agent.** The memory should be optimized for the
  *consuming agent's* retrieval and comprehension, not for human readability or external
  audience — store the form that makes future reasoning easiest.

---

## 12. The Synthesis — What "Revolutionary Vault for Agents" Means

Obsidian's magic decomposes into a stack we can reproduce and, in several places, *exceed*
because our user is a machine that never tires of linking:

1. **Ownership substrate** — local-first SQLite + lossless markdown export = "your data,
   forever." (Vault concept.)
2. **First-class connection** — entity co-occurrence + vector neighbors = wikilinks +
   backlinks, with **automated unlinked-mentions** as our signature advantage.
3. **Reflective structure** — the D3 `/api/graph` = global/local graph + JSON Canvas export
   so memory becomes a real Obsidian artifact.
4. **Structured queryability** — properties/Bases/Dataview = typed memory metadata + a
   model-friendly query DSL + auto-extracted inline fields.
5. **Continuity & trust** — versions/diffs, snapshots, namespace selective-sync, access log,
   shared namespaces = Obsidian Sync for teams of agents.
6. **Shareability** — a read-only memory wiki (Publish) with graph, backlinks, search,
   selective publish behind the existing tunnel.
7. **Frictionless capture** — auto session-notes + per-`document_type` templates +
   auto-extraction = daily notes + templates, so agents record by default.
8. **The soul** — *Writing is telepathy*: durable, atomic, densely-linked, concept-oriented,
   continuously-refined memory that lets one mind transmit to another across time.

**The single most differentiated, buildable-now move:** ship **automated unlinked mentions**
(§2) + **JSON Canvas export** (§4) + a **read-only memory wiki** (§7). Those three turn the
existing graph/entity/search machinery into something that *feels* like Obsidian — owned,
connected, navigable, shareable — while doing for agents what Obsidian does for humans, and
doing the linking work the human never could.

---

## Citations

- Obsidian homepage (pillars, "Writing is telepathy", Links/Graph/Canvas/Plugins/Sync copy): https://obsidian.md/
- Internal links (wikilink syntax, headings, blocks, aliases, embeds, unresolved): https://obsidian.md/help/links
- Backlinks (linked vs unlinked mentions, in-document backlinks): https://obsidian.md/help/plugins/backlinks
- Graph view (local/global, nodes/edges, filters, groups, forces, time-lapse): https://obsidian.md/help/plugins/graph
- Canvas (cards, edges, groups, JSON Canvas format): https://obsidian.md/help/plugins/canvas
- JSON Canvas 1.0 spec (nodes/edges schema, colors): https://jsoncanvas.org/spec/1.0/
- Plugin anatomy (Plugin class, onload/onunload): https://docs.obsidian.md/Plugins/Getting+started/Anatomy+of+a+plugin
- MetadataCache API (resolvedLinks/unresolvedLinks, getFileCache, events): https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache
- Obsidian Sync (E2E AES-256, version history, selective sync, shared vaults, snapshots): https://obsidian.md/sync
- Obsidian Publish (graph, backlinks, stacked pages, hover previews, custom domain, password, selective publish): https://obsidian.md/publish
- Properties (YAML frontmatter, types, tags/aliases, Properties view): https://obsidian.md/help/properties
- Bases (database views, table/cards/list/map, filters, formulas, .base): https://obsidian.md/help/bases
- Daily Notes + Templates ({{date}} placeholders, capture habit): https://obsidian.md/help/plugins/daily-notes
- Dataview docs (DQL, TABLE/LIST/TASK/CALENDAR, frontmatter + inline fields): https://blacksmithgu.github.io/obsidian-dataview/
- Dataview query structure: https://blacksmithgu.github.io/obsidian-dataview/queries/structure/
- Andy Matuschak — Evergreen notes (five principles): https://notes.andymatuschak.org/Evergreen_notes
- Nick Milo / LYT — Maps of Content & Idea Emergence: https://www.linkingyourthinking.com/
- Zettelkasten second-brain in Obsidian (fleeting/literature/permanent/structure notes): https://bryanhogan.com/blog/obsidian-zettelkasten
