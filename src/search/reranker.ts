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

/**
 * Reads the relevance score out of a ms-marco cross-encoder's raw logits.
 *
 * `Xenova/ms-marco-MiniLM-L-6-v2` is a SINGLE-logit relevance regressor: it
 * emits one number per (query, doc) pair, higher = more relevant. The raw logit
 * IS the score — we deliberately do NOT softmax it. (Running the model through
 * the text-classification pipeline applies softmax over that 1-element vector,
 * which is always [1.0], so every doc scored a constant 1.0 and the reranker
 * could never reorder anything.) Pure & testable, so the only genuinely
 * untestable code in {@link CrossEncoderReranker} is the model load/inference.
 */
export function extractRelevanceScore(logits: number[]): number {
  return logits[0];
}

/**
 * Map a raw ms-marco cross-encoder logit to a 0–1 relevance probability via
 * sigmoid. The raw logit is unbounded (hard to threshold); sigmoid gives a
 * stable score that is comparable ACROSS queries, unlike a per-query min-max.
 * Surfaced as `SearchResult.rerank_score` so callers can cut on relevance.
 */
export function rerankRelevance(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}

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

  private tokenizer: any = null;
  private model: any = null;
  private ready: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(modelName?: string) {
    this.modelName =
      modelName ?? process.env.MCP_MEMORY_RERANKER_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
  }

  async rerank(
    _query: string,
    docs: { id: string; text: string }[],
  ): Promise<Array<{ id: string; score: number }>> {
    if (docs.length === 0) return [];
    /* c8 ignore start */
    // Model load + per-doc inference — never exercised in the hermetic test
    // suite (would require downloading and running the real cross-encoder).
    await this.ensureInitialized();

    const results: Array<{ id: string; score: number }> = [];
    for (const doc of docs) {
      // Feed the (query, doc) pair as a sentence pair via the tokenizer's
      // text_pair, then run the model directly — the text-classification
      // pipeline ignores text_pair and softmaxes the single logit to a constant
      // 1.0, destroying the ranking signal. extractRelevanceScore reads the raw
      // relevance logit (higher = more relevant).
      const inputs = await this.tokenizer!(_query, {
        text_pair: doc.text,
        padding: true,
        truncation: true,
      });
      const { logits } = await this.model!(inputs);
      const score = extractRelevanceScore(Array.from(logits.data as Float32Array));
      results.push({ id: doc.id, score });
    }
    return results;
    /* c8 ignore stop */
  }

  isReady(): boolean {
    return this.ready;
  }

  /* c8 ignore start */
  // Model download/load — never exercised with the real model in the suite
  // (the init-dedup tests drive it with an injected loader).
  private async initialize(): Promise<void> {
    if (this.ready) return;

    // Dedupe concurrent first calls onto ONE in-flight load (mirrors
    // ../embeddings/transformers.ts): pre-fix, N callers each saw ready=false
    // and launched N parallel ~250MB ONNX loads in one process. The memo is
    // cleared once settled so a FAILED load is retried by a later call instead
    // of caching the rejection forever; after success `ready` short-circuits.
    if (!this.initPromise) {
      this.initPromise = this.loadModel().finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  /** The actual one-shot model load — only ever entered via the memo above. */
  private async loadModel(): Promise<void> {
    console.error('Loading reranker model (first time may take a few seconds)...');
    try {
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import(
        '@huggingface/transformers'
      );
      this.tokenizer = await AutoTokenizer.from_pretrained(this.modelName);
      this.model = await AutoModelForSequenceClassification.from_pretrained(this.modelName, {
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
