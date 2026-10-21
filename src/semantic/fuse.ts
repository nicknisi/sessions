// Pure, dependency-free fusion math: cosine similarity, a brute-force top-K scan
// over stored session vectors, and Reciprocal Rank Fusion of the lexical and
// semantic ranked lists.
//
// RRF over score mixing: BM25 scores are negative and unbounded while cosine is
// in [-1, 1]; fusing by RANK sidesteps that calibration mismatch entirely.
//
// # ponytail: brute-force scan; ANN/sqlite-vec only if the corpus grows 100×.

export interface VectorRow {
  filePath: string;
  model: string;
  dim: number;
  vec: Float32Array;
}

// # ponytail: fixed constants; tune only against a logged real miss, per EVAL.md.
export const RRF_K = 60;
/** Cosine floor below which a nearest-vector match is ignored. 0.45 suits a model
 *  with a wide cosine spread (the OpenAI text-embedding-3 family); see
 *  abstentionThreshold() for why that default is model-specific. */
export const ABSTENTION_THRESHOLD = 0.45;

/** The abstention floor actually in force: SESSIONS_EMBED_THRESHOLD when it parses
 *  to a number strictly inside (0, 1), else the default above. Cosine distributions
 *  are model-specific — the e5 family compresses unrelated pairs into roughly
 *  0.75–0.95, where 0.45 filters nothing, while text-embedding-3 can sit lower — so
 *  the floor is a per-corpus knob rather than one constant for every model. */
export function abstentionThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SESSIONS_EMBED_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return ABSTENTION_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : ABSTENTION_THRESHOLD;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Brute-force cosine of `query` against every row, highest similarity first.
 *  Rows whose dimensionality differs from the query are skipped — a vector from a
 *  different model/dim lives in a different space and must never be compared. */
export function topKSimilar(query: Float32Array, rows: VectorRow[], k = 50): Array<{ filePath: string; sim: number }> {
  const scored = rows
    .filter((r) => r.dim === query.length)
    .map((r) => ({ filePath: r.filePath, sim: cosine(query, r.vec) }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, Math.max(0, k));
}

/** RRF: score(d) = Σ 1 / (k + rank_i(d)), rank 0-based, over the two ranked lists.
 *  A document present in both lists compounds; a document in one still scores. */
export function fuseRRF(lexical: string[], semantic: string[], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  const add = (list: string[]): void => {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  };
  add(lexical);
  add(semantic);
  return scores;
}
