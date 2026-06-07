// VENDORED VERBATIM from tokenmaxing/src/pricing.ts — do not edit logic here; keep in sync. Public contract: schemaVersion 2.
export interface ModelPricing {
  inputUSDPer1M: number;
  outputUSDPer1M: number;
  cacheReadUSDPer1M?: number;
  cacheWriteUSDPer1M?: number;
}

export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Verify these against published prices on first publish.
// Update when new models ship; old entries can stay for historical accuracy.
export const PRICING: Record<string, ModelPricing> = {
  // Anthropic — Claude
  'claude-opus-4-7': { inputUSDPer1M: 15, outputUSDPer1M: 75, cacheReadUSDPer1M: 1.5, cacheWriteUSDPer1M: 18.75 },
  'claude-opus-4-6': { inputUSDPer1M: 15, outputUSDPer1M: 75, cacheReadUSDPer1M: 1.5, cacheWriteUSDPer1M: 18.75 },
  'claude-sonnet-4-6': { inputUSDPer1M: 3, outputUSDPer1M: 15, cacheReadUSDPer1M: 0.3, cacheWriteUSDPer1M: 3.75 },
  'claude-haiku-4-5': { inputUSDPer1M: 1, outputUSDPer1M: 5, cacheReadUSDPer1M: 0.1, cacheWriteUSDPer1M: 1.25 },

  // OpenAI — Codex (GPT-5 family; verify before first publish)
  'gpt-5-5-codex': { inputUSDPer1M: 5, outputUSDPer1M: 15 },
  'gpt-5-codex': { inputUSDPer1M: 5, outputUSDPer1M: 15 },

  // Baseten — open-weight models routed via Pi
  'moonshotai/Kimi-K2.5': { inputUSDPer1M: 0.5, outputUSDPer1M: 2.0 },
};

export function getPricing(modelId: string): ModelPricing | undefined {
  return PRICING[modelId];
}

export function computeCost(modelId: string, usage: UsageCounts): number {
  const p = PRICING[modelId];
  if (!p) return 0;
  return (
    (usage.input * p.inputUSDPer1M) / 1_000_000 +
    (usage.output * p.outputUSDPer1M) / 1_000_000 +
    (usage.cacheRead * (p.cacheReadUSDPer1M ?? 0)) / 1_000_000 +
    (usage.cacheWrite * (p.cacheWriteUSDPer1M ?? 0)) / 1_000_000
  );
}
