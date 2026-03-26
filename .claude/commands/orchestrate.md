Execute the task described in $ARGUMENTS using a structured multi-agent workflow. Run through each phase sequentially, using the Agent tool to spawn specialized agents in parallel where possible.
---
## Phase 1 — Architect
Spawn an Agent (subagent_type: "Explore") to research the codebase and answer:
1. Which existing files, components, stores, hooks, services, and navigators are relevant to this task?
2. Are there existing patterns, utilities, or abstractions that should be reused?
3. What are the integration points (navigation, store wiring, API calls)?
4. Are there any constraints or gotchas (circular deps, naming collisions, existing tech debt)?
Collect the findings before proceeding.
---
## Phase 2 — Planner
Spawn an Agent (subagent_type: "Plan") with the architect's findings and the original task. It must produce:
1. A step-by-step implementation plan with numbered tasks
2. For each task: the file(s) to create or modify, what changes are needed, and why
3. The order of operations (what depends on what)
4. A list of files that need to be read before editing
Present the plan to the user and wait for confirmation before proceeding. If the user requests changes, update the plan accordingly.
---
## Phase 3 — Developer(s)
Once the plan is approved, execute it. For each independent group of tasks in the plan, spawn parallel Agents (subagent_type: "general-purpose") to implement them. Each developer agent receives:
- The approved plan (relevant tasks only)
- The architect's findings
- A reminder to follow all CLAUDE.md conventions
After all developer agents complete, review the collective output for consistency.
---
## Phase 4 — Review
After implementation is complete, run the following checks:
1. `yarn tsc --noEmit` — type check
2. `yarn lint` — ESLint check
3. Review all changed files for CLAUDE.md convention compliance (imports, styles, naming, file structure)
Fix any issues found. Report a summary of what was built and any remaining items the user should be aware of.
---
## Rules
- Always follow the project's CLAUDE.md conventions
- Do not skip phases — each phase informs the next
- Present the plan to the user before writing any code
- Use parallel agents where tasks are independent
- Keep the user informed at each phase transition