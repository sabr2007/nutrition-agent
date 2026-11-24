// USD per 1M tokens (input, output), OpenAI list prices checked 2026-11-24. The ChatGPT plan
// has no marginal cost: these numbers only show what the same usage would cost on the API.
export const PRICES: Record<string, { in: number; out: number }> = {
  'gpt-6-luna': { in: 0.1, out: 0.5 },
  'gpt-6.1-terra': { in: 1, out: 5 },
  'gpt-6.1-sol': { in: 2, out: 10 },
};

export function costUsd(model: string, tokensIn = 0, tokensOut = 0): number {
  const p = PRICES[model];
  if (!p) return 0;
  return Number(((tokensIn * p.in + tokensOut * p.out) / 1_000_000).toFixed(6));
}
