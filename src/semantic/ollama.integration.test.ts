// Env-gated round-trip against a REAL local Ollama. Skipped unless
// SESSIONS_OLLAMA_TEST=1, so CI (and any machine without Ollama) never runs it.
// Run manually with:
//   SESSIONS_OLLAMA_TEST=1 bun test src/semantic/ollama.integration.test.ts
// It asserts the one property the fake embedder can't: real embeddings put two
// paraphrases closer than an unrelated sentence.

import { test, expect } from 'bun:test';
import { cosine } from './fuse';
import { detectEmbedder, clearEmbedderForTests } from './embed';

const gated = process.env.SESSIONS_OLLAMA_TEST === '1' ? test : test.skip;

gated('real Ollama: paraphrases are closer than an unrelated sentence', async () => {
  clearEmbedderForTests();
  const embedder = await detectEmbedder();
  if (!embedder) throw new Error('SESSIONS_OLLAMA_TEST=1 but no Ollama/model detected on localhost');

  const [a, b, c] = await embedder.embed([
    'the tests are flaky and fail at random',
    'our ci pipeline has intermittent failures',
    'the invoice pdf export is missing a total row',
  ]);
  const va = Float32Array.from(a!);
  const vb = Float32Array.from(b!);
  const vc = Float32Array.from(c!);
  expect(cosine(va, vb)).toBeGreaterThan(cosine(va, vc));
});
