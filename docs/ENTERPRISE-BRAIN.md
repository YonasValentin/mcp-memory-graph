# Enterprise AI Brain: org-aware memory on existing primitives

This page is a recipe. It shows how to build the "enterprise brain" pattern from features this server already ships: one shared memory server where the AI knows **who is asking** (role, team, manager), **what they may see** (per-employee permissions), and **how the organization fits together** (employees, projects, SOPs, and tools as a clickable graph). No plugin, no schema fork.

Two ideas make it "enterprise" rather than personal:

1. **Permissions are enforced, not advisory.** A sales key physically cannot read HR memories. Namespace walls and access-level ceilings are checked on every read path (search, by-id, lists, aggregates/counts, exports), with 404 non-confirmation instead of existence oracles. This is the per-key RBAC layer (schema v16+), adversarially battle-tested.
2. **The org chart is graph data.** Employees, departments, projects, SOPs, and tools are typed entities with typed relationships (`manages`, `works_on`, `follows`, `uses`), declared explicitly. "Show me this department" becomes a graph query, and the chat layer can surface people, SOPs, and tools as linked references.

## 1. One server, per-employee keys

Run one shared server over one SQLite file (see README → *Shared server*):

```bash
MCP_PORT=3100 MCP_BIND=127.0.0.1 node dist/index.js serve   # behind your TLS proxy
```

Mint **one key per employee (or per agent)**, pinned to the namespaces they may read and an access-level ceiling:

```bash
memory keys create --principal alice  --namespaces eng        --max-access-level internal
memory keys create --principal bob    --namespaces sales      --max-access-level internal
memory keys create --principal carol  --namespaces hr,eng     --max-access-level confidential
memory keys create --principal cfo-bot --namespaces finance,sales --max-access-level restricted
```

You get these properties immediately, all enforced server-side on every request:

- bob's key **cannot** see HR content: not in search results, not by id (404, no existence confirmation), not in counts (`/api/stats` is ceiling- and namespace-filtered), not via an explicit `namespace=hr` parameter (403 `NAMESPACE_NOT_PERMITTED`).
- carol's *confidential* ceiling lets her see confidential HR rows; alice's *internal* ceiling hides confidential eng rows **even inside her own namespace**.
- Multi-namespace keys (carol: `hr,eng`) pick their effective namespace per call; unset defaults to the first.
- Revocation (`memory keys revoke`) takes effect on the next request, no restart.
- Every memory a key writes is attributed to its principal; REST edits record `changed_by: <principal>` in version history.

Wire each employee's MCP client at onboarding:

```bash
npx mcp-memory-graph init --remote https://memory.example.com --token-env MEMORY_MCP_TOKEN
```

## 2. Who the employee is: profile + working context

Give the AI standing context about the person behind the key:

- **Profile memory** (one per employee, in a shared `org` namespace or the employee's home namespace):

```
memory_store {
  title: "org: Alice Nguyen",
  content: "Alice Nguyen, Staff Engineer, Platform team. Reports to Dana Kim.
            Working on project Orbit (launch infra). Strengths: Postgres, k8s.
            On-call rotation: A.",
  document_type: "note", scope: "team", namespace: "org", tags: ["org","employee"]
}
```

- **Core memory** (`core_memory_append`) for always-loaded facts the assistant should never have to search for (name, role, current top priority).
- **Expertise profile** (`memory_expertise` with `action: "observe"`) accrues per-agent topic levels over time.
- **Session state** (`memory_session_note`) carries running working context within a day.

## 3. The org graph: declared, typed, queryable

Entities and relationships are declared explicitly with `memory_extract_entities` against the profile and SOP memories. The graph is data you control, not NER guesswork alone:

```
memory_extract_entities {
  memory_id: "<id of 'org: Alice Nguyen'>",
  entities: [
    { name: "Alice Nguyen", type: "person",     description: "Staff Engineer, Platform" },
    { name: "Dana Kim",     type: "person" },
    { name: "Platform",     type: "team" },
    { name: "Orbit",        type: "project" },
    { name: "Incident response SOP", type: "sop" },
    { name: "Kubernetes",   type: "tool" }
  ],
  relationships: [
    { source: "Dana Kim",     target: "Alice Nguyen", type: "manages"  },
    { source: "Alice Nguyen", target: "Platform",     type: "member_of" },
    { source: "Alice Nguyen", target: "Orbit",        type: "works_on" },
    { source: "Alice Nguyen", target: "Kubernetes",   type: "uses"     },
    { source: "Platform",     target: "Incident response SOP", type: "follows" }
  ]
}
```

Entity types for org modeling: `person`, `team`, `department`, `project`, `sop`, `tool`, `agent`, `organization`. Relationship types: `manages`, `reports_to`, `member_of`, `works_on`, `owns`, `follows`, plus the software-ecosystem set (`uses`, `depends_on`, `part_of`, …).

Query it:

- `memory_graph { entity: "Dana Kim", depth: 2 }` → Dana's reports, their projects, the SOPs those teams follow.
- `memory_graph { entity_type: "sop" }` → every SOP node.
- `memory_communities` → emergent department/topic clusters.
- The web dashboard renders the same graph clickable (nodes → connected memories), and `memory_search { use_graph: true }` blends graph proximity into retrieval, so asking about "Orbit launch risks" surfaces memories linked through the project node.

Tenancy note: entities inherit the writing memory's `(scope, namespace)`. An org graph in the shared `org` namespace is readable by keys that include `org` in their namespace set, while each department's *content* memories stay behind their own walls.

## 4. SOPs and documents

Ingest the SOP text itself so the graph node has substance behind it:

```
memory_ingest {
  title: "Incident response SOP",
  content: "<the full SOP markdown>",
  document_type: "reference", scope: "team", namespace: "org",
  tags: ["sop","ops"]
}
```

Then link it (`memory_extract_entities` on the parent id, entity type `sop`). Searches hit the chunked content; the graph hop connects it to the teams and people who follow it. `memory_unlinked_mentions` proposes links you have not declared yet.

## 5. What this buys over a personal-brain setup

| Enterprise need | Mechanism here |
|---|---|
| Sales must not see HR | per-key namespace sets, enforced on every read path, incl. counts |
| Confidential tiers inside a dept | per-key `max-access-level` ceiling |
| "AI knows who I am" | profile memory + core memory + expertise + key principal |
| Org chart the AI can traverse | typed entities/relationships, declared via `memory_extract_entities` |
| SOPs/tools as first-class nodes | `sop`/`tool` entity types over ingested docs |
| Audit: who changed what | version history + `changed_by` principal attribution |
| Leaver offboarding | `memory keys revoke` (instant) + GDPR `memory_forget` |
| Review-gated knowledge | git-vault mode: memories as Markdown PRs |

## Boundaries (read before deploying)

- RBAC is **per server process**. For multi-instance deployments, shard tenants across processes or databases. A separate DB per tenant remains the strongest boundary.
- Graph/community **entity names** aggregate within their namespace; member memory ids are ceiling-filtered. Keep genuinely secret names out of entity names (they are labels, not content).
- The `org` namespace is readable by every key that includes it: treat it as internal-directory data, not a secrets store.
