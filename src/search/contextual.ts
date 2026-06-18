/**
 * Contextual indexing — a cheap, high-impact retrieval lever.
 *
 * Before EMBEDDING a memory we prepend a short, deterministic context prefix
 * that situates it (its title / document_type / namespace / section). The
 * vector then captures context the bare chunk loses, without any LLM call.
 *
 * The RAW content is always stored unchanged — the prefix only affects what
 * gets embedded.
 *
 * Stability invariant: `buildContextPrefix` returns '' when there is no
 * meaningful context, so `contextualizeForEmbedding(content, {})` is
 * byte-identical to the bare content. Only titled/typed/namespaced memories
 * get a prefix; everything else embeds exactly as it does today.
 */

export interface ContextHints {
  title?: string | null;
  document_type?: string | null;
  namespace?: string | null;
  /** Reserved for future chunk-level use; included in the prefix when present. */
  section?: string | null;
}

// Namespaces that carry no retrieval signal — treated as absent so they never
// pollute the embedding prefix.
const DEFAULT_NAMESPACES = new Set(['default', 'auto', 'global']);

/** Trim a field and return undefined when it has no meaningful value. */
function clean(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Builds a compact, deterministic one-line context prefix from the present
 * fields, e.g. `"Auth System — decision — namespace: acme"`. Returns '' when
 * none of the meaningful fields are present.
 */
export function buildContextPrefix(ctx: ContextHints): string {
  const title = clean(ctx.title);
  const documentType = clean(ctx.document_type);
  const section = clean(ctx.section);

  const rawNamespace = clean(ctx.namespace);
  const namespace =
    rawNamespace && !DEFAULT_NAMESPACES.has(rawNamespace.toLowerCase()) ? rawNamespace : undefined;

  const parts: string[] = [];
  if (title) parts.push(title);
  if (documentType) parts.push(documentType);
  if (namespace) parts.push(`namespace: ${namespace}`);
  if (section) parts.push(`section: ${section}`);

  return parts.join(' — ');
}

/**
 * Returns the text to embed: the context prefix joined to the content by a
 * blank line, or the bare content unchanged when there is no context.
 */
export function contextualizeForEmbedding(content: string, ctx: ContextHints): string {
  const prefix = buildContextPrefix(ctx);
  return prefix ? `${prefix}\n\n${content}` : content;
}
