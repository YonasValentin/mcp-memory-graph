/**
 * Pillar 6 (T19): per-document_type template scaffolds ("templates for agents").
 *
 * Obsidian-style note templates so memories an agent stores end up structurally
 * consistent across a corpus. These are pure, read-only scaffolds — nothing is
 * persisted here. An agent fetches a scaffold (via {@link handleTemplate}),
 * fills the sections, then stores the result through the normal memory_store.
 *
 * Each entry's `template` is a markdown scaffold with `## Section` headers and a
 * placeholder line under each; `fields` lists the section names so a caller can
 * introspect the structure without parsing the markdown.
 */

export interface TemplateResult {
  document_type: string;
  template: string;
  fields: string[];
  /** true for a recognized document_type, false when a generic default is returned. */
  known: boolean;
}

/** Placeholder line written under an empty section (shared by scaffold + fill). */
const PLACEHOLDER = '_…_';

/**
 * Build a markdown scaffold from an ordered list of section names. Each section
 * becomes a `## Section` header followed by a placeholder line.
 */
function scaffold(fields: string[]): string {
  return fields.map((field) => `## ${field}\n${PLACEHOLDER}`).join('\n\n') + '\n';
}

/** Normalize a section name to a lookup key so callers may pass snake_case. */
function normalizeKey(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/** Known scaffolds, keyed by document_type. */
export const TEMPLATES: Record<string, { template: string; fields: string[] }> = (() => {
  // One field list, keyed under both 'learning' (legacy) and 'lesson' (the
  // LEARNING_CATEGORIES name + memory_lesson's default document_type).
  const learningSections = ['What', 'Why it matters', 'How to apply'];
  const sections: Record<string, string[]> = {
    decision: ['Context', 'Decision', 'Consequences'],
    incident: ['Symptom', 'Root Cause', 'Fix', 'Prevention'],
    learning: learningSections,
    lesson: learningSections,
    'bug-fix': ['Bug', 'Cause', 'Fix', 'Test'],
    meeting: ['Attendees', 'Notes', 'Action Items'],
    session: ['Summary', 'Decisions', 'Next steps'],
  };
  const out: Record<string, { template: string; fields: string[] }> = {};
  for (const [type, fields] of Object.entries(sections)) {
    out[type] = { template: scaffold(fields), fields };
  }
  return out;
})();

/** Generic fallback for unrecognized document types. */
const GENERIC_FIELDS = ['Summary', 'Details', 'Notes'];

/**
 * Returns the template scaffold for `documentType`. For a recognized type the
 * matching scaffold is returned with `known:true`; otherwise a generic
 * Summary/Details/Notes scaffold is returned with `known:false` (and the
 * requested document_type echoed back so the caller can still use it on store).
 */
export function getTemplate(documentType: string): TemplateResult {
  const match = TEMPLATES[documentType];
  if (match) {
    return {
      document_type: documentType,
      template: match.template,
      fields: match.fields,
      known: true,
    };
  }
  return {
    document_type: documentType,
    template: scaffold(GENERIC_FIELDS),
    fields: GENERIC_FIELDS,
    known: false,
  };
}

/** Thin wrapper over {@link getTemplate} for the MCP tool handler. */
export function handleTemplate(input: { document_type: string }): TemplateResult {
  return getTemplate(input.document_type);
}

export interface FilledTemplate {
  content: string;
  fields: string[];
  known: boolean;
}

/**
 * Fill a scaffold's sections with caller-supplied values, keyed by the section
 * name (exact, e.g. "Root Cause", or normalized snake_case, e.g. "root_cause").
 * Uses the SAME field list and placeholder as {@link scaffold} so a filled note
 * is structurally identical to its empty scaffold — a missing or blank value
 * keeps the placeholder. Unknown document types fall back to the generic
 * sections (known:false), mirroring {@link getTemplate}.
 */
export function fillTemplate(
  documentType: string,
  values: Record<string, string>,
): FilledTemplate {
  const match = TEMPLATES[documentType];
  const fields = match ? match.fields : GENERIC_FIELDS;
  const content =
    fields
      .map((field) => {
        const raw = values[field] ?? values[normalizeKey(field)];
        const value = raw?.trim();
        return `## ${field}\n${value && value.length > 0 ? value : PLACEHOLDER}`;
      })
      .join('\n\n') + '\n';
  return { content, fields, known: Boolean(match) };
}
