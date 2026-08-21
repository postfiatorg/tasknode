import { randomInt } from "node:crypto";
import { loadPrompt } from "./prompt-registry.js";

const hexagrams = JSON.parse(loadPrompt("i_ching/hexagrams.json"));
const hexagramByPattern = new Map(hexagrams.map((entry) => [entry.pattern, entry]));

function linePolarity(value) {
  return value === 6 || value === 8 ? 0 : 1;
}

function patternFromLines(lines) {
  return lines.map(linePolarity).reverse().join("");
}

function publicHexagram(entry) {
  if (!entry) throw new Error("i_ching_hexagram_pattern_unknown");
  return {
    number: entry.kingwen,
    pattern: entry.pattern,
    symbol: entry.symbol,
    nameCn: entry.name_cn,
    nameEn: entry.name_en,
  };
}

export function generateIChingCast({ question = "", coin = () => randomInt(2) + 2 } = {}) {
  const normalizedQuestion = String(question || "").trim();
  if (!normalizedQuestion) throw new Error("i_ching_question_required");

  const lineValues = Array.from({ length: 6 }, () => coin() + coin() + coin());
  const relatingLineValues = lineValues.map((value) => value === 6 ? 7 : value === 9 ? 8 : value);
  const changingLines = lineValues
    .map((value, index) => value === 6 || value === 9 ? index + 1 : 0)
    .filter(Boolean);

  return {
    method: "three_coin",
    question: normalizedQuestion,
    lineOrder: "bottom_to_top",
    lineValues,
    changingLines,
    primary: publicHexagram(hexagramByPattern.get(patternFromLines(lineValues))),
    relating: publicHexagram(hexagramByPattern.get(patternFromLines(relatingLineValues))),
    generatedAt: new Date().toISOString(),
  };
}
