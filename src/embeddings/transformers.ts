import type { EmbeddingProvider } from './provider.js';
import { configuredDimensions } from '../db/schema.js';

const BATCH_SIZE = 32;

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;

  private pipeline: any = null;
  private ready: boolean = false;

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

  private async ensureInitialized(): Promise<void> {
    if (!this.ready) {
      await this.initialize();
    }
  }
}
