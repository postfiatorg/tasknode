export const DEFAULT_CHAT_PERSONA = "jobs";

export const CHAT_PERSONAS = Object.freeze([
  Object.freeze({
    id: "odv",
    name: "ODV",
    tagline: "Futuristic AI personality.",
  }),
  Object.freeze({
    id: "trading-coach",
    name: "Trading Coach",
    tagline: "Designed to advance trading goals.",
  }),
  Object.freeze({
    id: "jobs",
    name: "Jobs",
    tagline: "Best for tech and product development.",
  }),
  Object.freeze({
    id: "kravis",
    name: "Kravis",
    tagline: "Downside-first private equity discipline.",
  }),
]);

const chatPersonaIds = new Set(CHAT_PERSONAS.map((persona) => persona.id));

export function normalizeChatPersona(value = "", { fallback = DEFAULT_CHAT_PERSONA } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "coach") return "trading-coach";
  if (normalized === "steve-jobs" || normalized === "steve_jobs") return "jobs";
  if (normalized === "henry-kravis" || normalized === "henry_kravis") return "kravis";
  return chatPersonaIds.has(normalized) ? normalized : "";
}

export function chatPersonaDefinition(value = "") {
  const id = normalizeChatPersona(value);
  return CHAT_PERSONAS.find((persona) => persona.id === id) || CHAT_PERSONAS.find((persona) => persona.id === DEFAULT_CHAT_PERSONA);
}

export function chatPersonaUsesJobsRetrieval(value = "") {
  return normalizeChatPersona(value) === "jobs";
}
