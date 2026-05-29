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

/**
 * Build a markdown scaffold from an ordered list of section names. Each section
 * becomes a `## Section` header followed by a placeholder line.
 */
function scaffold(fields: string[]): string {
  return fields.map((field) => `## ${field}\n_…_`).join('\n\n') + '\n';
}

/** Known scaffolds, keyed by document_type. */
export const TEMPLATES: Record<string, { template: string; fields: string[] }> = (() => {
  const sections: Record<string, string[]> = {
    decision: ['Context', 'Decision', 'Consequences'],
    incident: ['Symptom', 'Root Cause', 'Fix', 'Prevention'],
    learning: ['What', 'Why it matters', 'How to apply'],
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
