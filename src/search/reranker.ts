/**
 * Pillar 3, T6 — optional local cross-encoder reranking stage.
 *
 * The base embedder (all-MiniLM) is a bi-encoder: it embeds query and document
 * independently, so it can miss fine-grained relevance. A cross-encoder reads
 * the (query, document) pair jointly and produces a single relevance score —
 * the single biggest precision win for a weak base embedder. We run it only
 * over the top-N hybrid-search candidates (reranking is too expensive to apply
 * to the whole corpus).
 *
 * The interface is pluggable so tests inject a deterministic stub and never
 * download a model; the real implementation lazy-loads on first use.
 */

/** Reorders candidate docs for a query by joint relevance. */
export interface Reranker {
  /** Returns one {id, score} per input doc (higher = more relevant). Order need
   *  not match input; callers reorder by score. */
  rerank(
    query: string,
    docs: { id: string; text: string }[],
  ): Promise<Array<{ id: string; score: number }>>;
}

/**
 * Local cross-encoder reranker backed by `Xenova/ms-marco-MiniLM-L-6-v2` via
 * `@huggingface/transformers`. The model is lazy-loaded on first {@link rerank}
 * call (mirrors {@link ../embeddings/transformers.ts}), so constructing the
 * class is cheap and hermetic — no download happens until you actually rerank.
 */
export class CrossEncoderReranker implements Reranker {
  readonly modelName: string;

  private pipeline: any = null;
  private ready: boolean = false;

  constructor(modelName?: string) {
    this.modelName =
      modelName ?? process.env.MCP_MEMORY_RERANKER_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
  }

  async rerank(
    _query: string,
    docs: { id: string; text: string }[],
  ): Promise<Array<{ id: string; score: number }>> {
    if (docs.length === 0) return [];
    await this.ensureInitialized();

    const results: Array<{ id: string; score: number }> = [];
    for (const doc of docs) {
      // ms-marco cross-encoders are single-logit relevance regressors; the
      // text-classification pipeline surfaces that logit as `score`.
      const output = await this.pipeline!(
        { text: _query, text_pair: doc.text },
        { top_k: 1 },
      );
      const score = Array.isArray(output) ? (output[0]?.score ?? 0) : (output?.score ?? 0);
      results.push({ id: doc.id, score });
    }
    return results;
  }

  isReady(): boolean {
    return this.ready;
  }

  /* c8 ignore start */
  // Model download/load — never exercised in the hermetic test suite.
  private async initialize(): Promise<void> {
    if (this.ready) return;

    console.error('Loading reranker model (first time may take a few seconds)...');
    try {
      const { pipeline } = await import('@huggingface/transformers');
      this.pipeline = await pipeline('text-classification', this.modelName, {
        dtype: 'fp32' as const,
        device: 'cpu' as const,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load reranker model "${this.modelName}": ${message}`);
    }
    this.ready = true;
    console.error('Reranker model loaded successfully.');
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.ready) {
      await this.initialize();
    }
  }
  /* c8 ignore stop */
}
