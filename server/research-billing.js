import { validatorError } from "./validator-identity.js";

export function researchLedgerAmount(cost) {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > Number.MAX_SAFE_INTEGER / 1e6) {
    throw validatorError("research_cost_invalid", 502);
  }
  if (Math.abs(cost * 1e12 - Math.round(cost * 1e12)) > 0.001) throw validatorError("research_cost_precision_invalid", 502);
  // Exact decimal integer arithmetic avoids an extra microdollar caused by
  // binary floating-point multiplication at a six-decimal boundary.
  const [dollars, fraction] = cost.toFixed(12).split(".");
  const picoDollars = BigInt(dollars) * 1000000000000n + BigInt(fraction);
  return Number((picoDollars + 999999n) / 1000000n) / 1000000;
}
