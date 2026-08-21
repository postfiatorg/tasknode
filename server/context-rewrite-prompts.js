import { loadPrompt, promptDigest, renderPromptTemplate } from "./prompt-registry.js";

export const contextRewriteScorePromptVersion = "context_rewrite_score_v1";
export const contextRewriteSearchQueryPromptVersion = "context_rewrite_search_query_v1";
export const contextRewriteFinalPromptVersion = "context_rewrite_final_v1";
export const contextRewritePolishPromptVersion = "context_rewrite_polish_v1";

const scorePrompt = loadPrompt("context/context_rewrite_score_v1.md");
const searchQueryPrompt = loadPrompt("context/context_rewrite_search_query_v1.md");
const finalPrompt = loadPrompt("context/context_rewrite_final_v1.md");
const polishPrompt = loadPrompt("context/context_rewrite_polish_v1.md");

export const contextRewriteScorePromptSha256 = promptDigest(scorePrompt);
export const contextRewriteSearchQueryPromptSha256 = promptDigest(searchQueryPrompt);
export const contextRewriteFinalPromptSha256 = promptDigest(finalPrompt);
export const contextRewritePolishPromptSha256 = promptDigest(polishPrompt);

export function renderContextRewriteScorePrompt({ runIndex = 1, modelFamily = "" } = {}) {
  const family = String(modelFamily || "model").trim();
  const decorrelation = [
    `This is independent scorer run ${runIndex}.`,
    family ? `Model family: ${family}.` : "",
    "Be strict about specificity, task-history interpretation, best-practice grounding, and downstream usefulness.",
    "Do not calibrate toward politeness or preserve weak source structure.",
  ].filter(Boolean).join(" ");
  return renderPromptTemplate(scorePrompt, {
    RUN_DECORRELATION: decorrelation,
  });
}

export function contextRewriteSearchQueryPromptText() {
  return searchQueryPrompt;
}

export function contextRewriteFinalPromptText() {
  return finalPrompt;
}

export function contextRewritePolishPromptText() {
  return polishPrompt;
}
