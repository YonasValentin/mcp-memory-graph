import type { AccessLevel, MemoryScope } from '../types.js';
import type { EmbeddingProvider } from './provider.js';

/**
 * M6.4 (R8) — Pluggable embeddings / Ollama router, privacy-gated.
 *
 * A logical-key -> {@link EmbeddingProvider} registry plus
 * {@link selectEmbedder}, which picks a provider for a given operation. The
 * load-bearing invariant: `confidential` and `restricted` memories are ALWAYS
 * embedded with the LOCAL provider, so confidential text is never shipped to a
 * remote (e.g. networked Ollama) endpoint — regardless of any caller
 * preference.
 *
 * DIMENSION CONSTRAINT (read before adding a second model): `memories_vec` is a
 * single fixed-dimension virtual table — `src/db/schema.ts` HARD-THROWS via
 * `assertDimensionConsistency` if an embedder's dimension differs from the
 * dimension the DB was built with. Supporting a second model therefore needs
 * EITHER (a) a per-model vec table, OR (b) reconciling every model to the one
 * DB dimension. We deliberately choose (b): {@link truncateTo} is a
 * Matryoshka-style truncate-then-renormalize adapter that projects an
 * over-wide model down to the DB dimension. This keeps the single-vec-table
 * invariant intact. A narrower model cannot be up-projected and is rejected.
 *
 * The DB column `embedding_model` (+ `embedding_dim`, both nullable, added in
 * the v11 migration) records which model produced each stored vector so a
 * targeted re-embed (`src/cli/rebuild.ts`) can find rows from another model.
 */
export class EmbeddingRegistry {
  private readonly providers = new Map<string, EmbeddingProvider>();
  private localProviderKey: string | null = null;

  /**
   * Register a provider under `key`. The FIRST registered provider is treated
   * as the privacy-safe LOCAL provider (used for confidential/restricted and as
   * the universal fallback). Pass `{ local: true }` to designate a later
   * registration as the local one explicitly. Re-registering a key throws.
   */
  register(
    key: string,
    provider: EmbeddingProvider,
    opts?: { local?: boolean },
  ): void {
    if (this.providers.has(key)) {
      throw new Error(`Embedding provider "${key}" is already registered.`);
    }
    this.providers.set(key, provider);
    if (this.localProviderKey === null || opts?.local) {
      this.localProviderKey = key;
    }
  }

  /** Whether `key` is registered. */
  has(key: string): boolean {
    return this.providers.has(key);
  }

  /** Retrieve a provider by key; throws a clear error for an unknown key. */
  get(key: string): EmbeddingProvider {
    const p = this.providers.get(key);
    if (p === undefined) {
      throw new Error(
        `Unknown embedding provider "${key}". Registered: ${this.keys().join(', ') || '(none)'}.`,
      );
    }
    return p;
  }

  /** All registered keys. */
  keys(): string[] {
    return [...this.providers.keys()];
  }

  /** The key of the designated privacy-safe local provider. */
  get localKey(): string {
    if (this.localProviderKey === null) {
      throw new Error('No local provider has been registered.');
    }
    return this.localProviderKey;
  }

  /** The designated privacy-safe local provider. */
  get local(): EmbeddingProvider {
    return this.get(this.localKey);
  }
}

/** Access levels that MUST stay on the local embedder. */
const LOCAL_ONLY_ACCESS: ReadonlySet<AccessLevel> = new Set<AccessLevel>([
  'confidential',
  'restricted',
]);

export interface SelectEmbedderInput {
  /** The memory operation requesting an embedding (store/search/reembed/…). */
  operation: string;
  /** The access level of the content being embedded. */
  access_level: AccessLevel;
  /** The memory scope (reserved for future scope-aware routing). */
  scope: MemoryScope;
  /**
   * Caller's preferred provider key. Honoured ONLY when the access level is not
   * confidential/restricted AND the key is registered; otherwise the local
   * provider is used.
   */
  preferred?: string;
}

/**
 * Pick an {@link EmbeddingProvider} for the given operation. Forces the local
 * provider for confidential/restricted access (the privacy gate); otherwise
 * honours `preferred` when it is registered, falling back to local.
 */
export function selectEmbedder(
  registry: EmbeddingRegistry,
  input: SelectEmbedderInput,
): EmbeddingProvider {
  if (LOCAL_ONLY_ACCESS.has(input.access_level)) {
    return registry.local;
  }
  if (input.preferred !== undefined && registry.has(input.preferred)) {
    return registry.get(input.preferred);
  }
  return registry.local;
}

/**
 * Matryoshka-style dimension adapter. Returns a provider whose vectors are the
 * first `target` components of `inner`'s output, renormalized to unit length —
 * the standard way to shrink a Matryoshka-trained embedding while preserving
 * cosine geometry. Returns `inner` unchanged when it already matches `target`.
 * Throws when `inner` is NARROWER than `target` (you cannot fabricate
 * dimensions).
 */
export function truncateTo(
  inner: EmbeddingProvider,
  target: number,
): EmbeddingProvider {
  if (inner.dimensions === target) return inner;
  if (inner.dimensions < target) {
    throw new Error(
      `Cannot truncate embeddings from ${inner.dimensions} up to ${target} dimensions; ` +
        `the source model is narrower than the target dimension.`,
    );
  }
  return new TruncatingEmbeddingProvider(inner, target);
}

/** Truncate-then-renormalize wrapper around a wider inner provider. */
class TruncatingEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly inner: EmbeddingProvider;

  constructor(inner: EmbeddingProvider, target: number) {
    this.inner = inner;
    this.dimensions = target;
  }

  get modelName(): string {
    return this.inner.modelName;
  }

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  isReady(): boolean {
    return this.inner.isReady();
  }

  async embed(text: string): Promise<Float32Array> {
    return truncateAndNormalize(await this.inner.embed(text), this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const vectors = await this.inner.embedBatch(texts);
    return vectors.map((v) => truncateAndNormalize(v, this.dimensions));
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.();
  }
}

/** First `target` components of `v`, renormalized to unit length. */
function truncateAndNormalize(v: Float32Array, target: number): Float32Array {
  const out = new Float32Array(target);
  let norm = 0;
  for (let i = 0; i < target; i++) {
    out[i] = v[i];
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < target; i++) out[i] /= norm;
  }
  return out;
}
