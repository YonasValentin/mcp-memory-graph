// Real-embedder gate: proves the actual all-MiniLM-L6-v2 model loads and
// produces semantically meaningful vectors (the 921-test suite uses a mock).
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const t0 = Date.now();
const p = new TransformersEmbeddingProvider();
await p.initialize();
const tInit = Date.now() - t0;

const q = 'How do we handle user authentication?';
const related = 'We use JWT bearer tokens with role-based access control for login.';
const unrelated = 'The CSS grid layout uses twelve columns on desktop.';

const t1 = Date.now();
const [eq, er, eu] = await p.embedBatch([q, related, unrelated]);
const tEmbed = Date.now() - t1;

console.log(JSON.stringify({
  model: p.modelName,
  dimensions: p.dimensions,
  vecLen: eq.length,
  initMs: tInit,
  embed3Ms: tEmbed,
  cos_query_related: +cosine(eq, er).toFixed(4),
  cos_query_unrelated: +cosine(eq, eu).toFixed(4),
  discriminates: cosine(eq, er) > cosine(eq, eu),
}, null, 2));
