// Env-gated round-trip against a REAL Text Embeddings Inference server. Skipped
// unless SESSIONS_TEI_TEST=1, so CI (and any machine without TEI) never runs it.
// Run manually with:
//   SESSIONS_TEI_TEST=1 SESSIONS_TEI_URL=http://localhost:8099 bun test src/semantic/tei.integration.test.ts
// It asserts the one property the fake server can't: real embeddings put two
// paraphrases closer than an unrelated sentence.

import { test, expect } from 'bun:test';
import { cosine } from './fuse';
import { detectEmbedder, clearEmbedderForTests } from './embed';

const gated = process.env.SESSIONS_TEI_TEST === '1' ? test : test.skip;

const TEI_URL = process.env.SESSIONS_TEI_URL ?? 'http://localhost:8080';

/** Both clients against the same live server: the native /embed route and TEI's
 *  OpenAI-compatible /v1/embeddings. */
async function roundTrip(provider: 'tei' | 'openai'): Promise<void> {
  process.env.SESSIONS_EMBED_PROVIDER = provider;
  process.env.SESSIONS_EMBED_URL = provider === 'openai' ? `${TEI_URL}/v1` : TEI_URL;
  delete process.env.SESSIONS_EMBED_API_KEY;
  clearEmbedderForTests();
  const embedder = await detectEmbedder();
  if (!embedder) throw new Error(`SESSIONS_TEI_TEST=1 but no TEI server at ${TEI_URL} (provider ${provider})`);
  expect(embedder.id).toStartWith(`${provider}:`);

  const [a, b, c] = await embedder.embed([
    'the tests are flaky and fail at random',
    'our ci pipeline has intermittent failures',
    'the invoice pdf export is missing a total row',
  ]);
  const va = Float32Array.from(a!);
  const vb = Float32Array.from(b!);
  const vc = Float32Array.from(c!);
  expect(cosine(va, vb)).toBeGreaterThan(cosine(va, vc));
}

gated('real TEI: paraphrases are closer than an unrelated sentence', async () => {
  await roundTrip('tei');
});

gated('real TEI via /v1/embeddings: the OpenAI client reads it too', async () => {
  await roundTrip('openai');
});
