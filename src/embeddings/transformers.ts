import type { EmbeddingProvider } from './provider.js';
import { configuredDimensions } from '../db/schema.js';

const BATCH_SIZE = 32;

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;

  private pipeline: any = null;
  private ready: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    modelName?: string,
    dims?: number,
  ) {
    this.modelName = modelName ?? process.env.MCP_MEMORY_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
    // Reuse the single validated parser (guards NaN / out-of-range and throws a
    // clear error) instead of a second unguarded parseInt that could yield NaN.
    this.dimensions = dims ?? configuredDimensions();
  }

  async initialize(): Promise<void> {
    if (this.ready) return;

    // Dedupe concurrent first calls onto ONE in-flight load: pre-fix, N callers
    // each saw ready=false and launched N parallel ~250MB ONNX loads in one
    // process (intermittent load failures under cold-start parallel load + a
    // native `mutex lock failed` abort at shutdown after the multi-load race).
    // The memo is cleared once settled so a FAILED load is retried by a later
    // call instead of caching the rejection forever — the embedder is load-
    // bearing, a transient disk/network error must not brick the process. After
    // success the `ready` check above short-circuits (and dispose() resets it).
    if (!this.initPromise) {
      this.initPromise = this.loadModel().finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  /** The actual one-shot model load — only ever entered via the memo above. */
  private async loadModel(): Promise<void> {
    console.error('Loading embedding model (first time may take a few seconds)...');
    try {
      const { pipeline } = await import('@huggingface/transformers');
      this.pipeline = await pipeline('feature-extraction', this.modelName, {
        dtype: 'fp32' as const,
        device: 'cpu' as const,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load embedding model "${this.modelName}": ${message}`,
      );
    }
    this.ready = true;
    console.error('Embedding model loaded successfully.');
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ensureInitialized();

    const output = await this.pipeline!(text, { pooling: 'mean', normalize: true });
    const data: Float32Array = output.data;

    if (data.length > this.dimensions) {
      return new Float32Array(data.slice(0, this.dimensions));
    }
    return new Float32Array(data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.ensureInitialized();

    const results: Float32Array[] = [];

    for (let batchStart = 0; batchStart < texts.length; batchStart += BATCH_SIZE) {
      const batch = texts.slice(batchStart, batchStart + BATCH_SIZE);
      const output = await this.pipeline!(batch, { pooling: 'mean', normalize: true });
      const data: Float32Array = output.data;
      const batchSize = batch.length;

      for (let i = 0; i < batchSize; i++) {
        const start = i * this.dimensions;
        const end = start + this.dimensions;
        results.push(new Float32Array(data.slice(start, end)));
      }
    }

    return results;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Releases the cached transformers.js pipeline (and the underlying
   * onnxruntime InferenceSession it holds). Idempotent and safe to call when
   * the model was never loaded.
   *
   * BATTLE-V3 P14: an in-process real embedder + an abrupt `process.exit()`
   * aborts with `std::system_error: mutex lock failed` (exit 134) because the
   * native ORT worker thread is torn down mid-flight. `dispose()` frees the
   * session for long-running graceful shutdown, but does NOT by itself prevent
   * the `process.exit()` race — force-exit scripts must additionally let the
   * event loop drain naturally (set `process.exitCode`, do not call
   * `process.exit()`). See scripts/battle/verify-{web,nli,hooks}.mjs.
   */
  async dispose(): Promise<void> {
    await this.pipeline?.dispose?.();
    this.pipeline = null;
    this.ready = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.ready) {
      await this.initialize();
    }
  }
}
