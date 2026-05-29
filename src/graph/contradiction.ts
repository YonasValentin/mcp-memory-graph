/**
 * Pillar 4, T10 — local NLI (Natural Language Inference) contradiction detection.
 *
 * The pre-T10 overlap heuristic ({@link ./conflict-resolver.ts}) keys off vector
 * proximity + keyword Jaccard, so it cannot tell "the API uses 3000" apart from
 * "the API does NOT use 3000" — they share almost every token. A real NLI model
 * reads each (premise, hypothesis) pair jointly and emits entailment / neutral /
 * contradiction, catching exactly those negations the heuristic misses. On a
 * detected contradiction the store retires (invalidates) the old fact — the
 * self-correcting-memory step.
 *
 * The classifier is pluggable (mirrors the T6 reranker): tests inject a
 * deterministic stub and never download a model; the real implementation
 * lazy-loads on first use, so it never runs on the default store path.
 */

export type NliLabel = 'entailment' | 'neutral' | 'contradiction';

/** Classifies the logical relation of a hypothesis to a premise. */
export interface NliClassifier {
  classify(premise: string, hypothesis: string): Promise<{ label: NliLabel; score: number }>;
}

/**
 * Normalizes a model's raw label string (e.g. "CONTRADICTION", "entailment")
 * to the three-class NLI vocabulary. Pure & testable, so the only genuinely
 * untestable code in {@link CrossEncoderNli} is the model load/inference itself.
 */
export function normalizeNliLabel(raw: string): NliLabel {
  const label = raw.toLowerCase();
  if (label.includes('contradiction')) return 'contradiction';
  if (label.includes('entailment')) return 'entailment';
  return 'neutral';
}

/**
 * Local MNLI cross-encoder backed by `Xenova/nli-deberta-v3-xsmall` via
 * `@huggingface/transformers`. The model is lazy-loaded on first {@link classify}
 * call (mirrors {@link ../search/reranker.ts}), so constructing the class is
 * cheap and hermetic — no download happens until you actually classify.
 */
export class CrossEncoderNli implements NliClassifier {
  readonly modelName: string;

  private pipeline: any = null;
  private ready: boolean = false;

  constructor(modelName?: string) {
    this.modelName =
      modelName ?? process.env.MCP_MEMORY_NLI_MODEL ?? 'Xenova/nli-deberta-v3-xsmall';
  }

  isReady(): boolean {
    return this.ready;
  }

  /* c8 ignore start */
  // Model inference — exercised only with the real model, never in the suite.
  // (The pure label mapping it relies on, normalizeNliLabel, is unit-tested.)
  async classify(premise: string, hypothesis: string): Promise<{ label: NliLabel; score: number }> {
    await this.ensureInitialized();

    // MNLI cross-encoders score the {premise, hypothesis} pair across three
    // labels; the text-classification pipeline surfaces the top label + score.
    const output = await this.pipeline!({ text: premise, text_pair: hypothesis }, { top_k: 1 });
    const top = Array.isArray(output) ? output[0] : output;
    return { label: normalizeNliLabel(String(top?.label ?? '')), score: top?.score ?? 0 };
  }

  // Model download/load — never exercised in the hermetic test suite.
  private async initialize(): Promise<void> {
    if (this.ready) return;

    console.error('Loading NLI model (first time may take a few seconds)...');
    try {
      const { pipeline } = await import('@huggingface/transformers');
      this.pipeline = await pipeline('text-classification', this.modelName, {
        dtype: 'fp32' as const,
        device: 'cpu' as const,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load NLI model "${this.modelName}": ${message}`);
    }
    this.ready = true;
    console.error('NLI model loaded successfully.');
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.ready) {
      await this.initialize();
    }
  }
  /* c8 ignore stop */
}

/**
 * Runs the injected classifier over a shortlist, treating each candidate's
 * content as the PREMISE and the new memory as the HYPOTHESIS, and returns the
 * candidates judged `contradiction` with score ≥ `minScore` (default 0.6).
 *
 * Pure with respect to the injected `nli` (no DB, no model of its own) — fully
 * unit-testable with a deterministic stub.
 */
export async function detectContradictions(
  nli: NliClassifier,
  newContent: string,
  candidates: { id: string; content: string }[],
  opts?: { minScore?: number },
): Promise<Array<{ id: string; score: number }>> {
  const minScore = opts?.minScore ?? 0.6;
  const hits: Array<{ id: string; score: number }> = [];
  for (const candidate of candidates) {
    const { label, score } = await nli.classify(candidate.content, newContent);
    if (label === 'contradiction' && score >= minScore) {
      hits.push({ id: candidate.id, score });
    }
  }
  return hits;
}
