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
 * Turns an NLI model's raw 3-way logits into a {label, score}: softmax over the
 * logits, take the argmax class, map its index through the model's `id2label`
 * (e.g. {0:contradiction, 1:entailment, 2:neutral}) and normalize. The score is
 * the softmax probability of the winning class.
 *
 * Why we do this by hand instead of via the text-classification pipeline: the
 * pipeline ignores the {text, text_pair} sentence-pair form, so it scored every
 * (premise, hypothesis) pair identically. Reading the model's logits directly
 * makes the result actually depend on the input. Pure & testable, so the only
 * genuinely untestable code in {@link CrossEncoderNli} is the model
 * load/inference itself.
 */
export function labelFromLogits(
  logits: number[],
  id2label: Record<string, string>,
): { label: NliLabel; score: number } {
  const max = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  let argmax = 0;
  for (let i = 1; i < exps.length; i++) {
    if (exps[i] > exps[argmax]) argmax = i;
  }
  return {
    label: normalizeNliLabel(id2label[String(argmax)] ?? ''),
    score: exps[argmax] / sum,
  };
}

/**
 * Local MNLI cross-encoder backed by `Xenova/nli-deberta-v3-xsmall` via
 * `@huggingface/transformers`. The model is lazy-loaded on first {@link classify}
 * call (mirrors {@link ../search/reranker.ts}), so constructing the class is
 * cheap and hermetic — no download happens until you actually classify.
 */
export class CrossEncoderNli implements NliClassifier {
  readonly modelName: string;

  private tokenizer: any = null;
  private model: any = null;
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
  // (The pure label mapping it relies on, labelFromLogits, is unit-tested.)
  async classify(premise: string, hypothesis: string): Promise<{ label: NliLabel; score: number }> {
    await this.ensureInitialized();

    // Feed the (premise, hypothesis) pair as a sentence pair via the tokenizer's
    // text_pair, then run the model directly — the text-classification pipeline
    // ignores text_pair, so it scored every pair identically. labelFromLogits
    // softmaxes the 3-way logits and maps the argmax via the model's id2label.
    const inputs = await this.tokenizer!(premise, {
      text_pair: hypothesis,
      padding: true,
      truncation: true,
    });
    const { logits } = await this.model!(inputs);
    return labelFromLogits(
      Array.from(logits.data as Float32Array),
      this.model!.config.id2label,
    );
  }

  // Model download/load — never exercised in the hermetic test suite.
  private async initialize(): Promise<void> {
    if (this.ready) return;

    console.error('Loading NLI model (first time may take a few seconds)...');
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
 * `bidirectional` (battle-v7 H6) — when set, a candidate is retired only when
 * BOTH directions agree it is a contradiction (premise↔hypothesis swapped).
 * A genuine contradiction is symmetric ("X is on 3000" vs "X is NOT on 3000"
 * reads as a contradiction either way), whereas the MNLI cross-encoder can
 * over-predict "contradiction" in a SINGLE direction for two mutually-compatible
 * facts on the same sub-topic — which would silently retire a valid memory. The
 * reverse pass filters those spurious one-way over-predictions out. The reported
 * score is the weaker (min) of the two directions. Off by default so the pure
 * single-direction plumbing tests keep their semantics; handleStore enables it.
 *
 * Pure with respect to the injected `nli` (no DB, no model of its own) — fully
 * unit-testable with a deterministic stub.
 */
export async function detectContradictions(
  nli: NliClassifier,
  newContent: string,
  candidates: { id: string; content: string }[],
  opts?: { minScore?: number; bidirectional?: boolean },
): Promise<Array<{ id: string; score: number }>> {
  const minScore = opts?.minScore ?? 0.6;
  const hits: Array<{ id: string; score: number }> = [];
  for (const candidate of candidates) {
    const forward = await nli.classify(candidate.content, newContent);
    if (forward.label !== 'contradiction' || forward.score < minScore) continue;
    if (opts?.bidirectional) {
      // Reverse pass: the new fact as premise, the existing fact as hypothesis.
      const reverse = await nli.classify(newContent, candidate.content);
      if (reverse.label !== 'contradiction' || reverse.score < minScore) continue;
      hits.push({ id: candidate.id, score: Math.min(forward.score, reverse.score) });
    } else {
      hits.push({ id: candidate.id, score: forward.score });
    }
  }
  return hits;
}
