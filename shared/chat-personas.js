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

export const CHAT_MODALITIES = Object.freeze([
  Object.freeze({
    id: "brainstorming",
    name: "Brainstorm",
    tagline: "Generate and pressure-test useful possibilities.",
    inputPlaceholder: "What do you want to brainstorm?",
  }),
  Object.freeze({
    id: "motivation",
    name: "Motivation",
    tagline: "Turn friction into a concrete next move.",
    inputPlaceholder: "What are you stuck on right now?",
  }),
  Object.freeze({
    id: "five-mirrors",
    name: "Five Mirrors",
    tagline: "See the situation through five distinct lenses.",
    inputPlaceholder: "What situation should the five mirrors examine?",
  }),
  Object.freeze({
    id: "i-ching",
    name: "I Ching",
    tagline: "Ask a question and cast a fresh hexagram.",
    inputPlaceholder: "What situation or decision do you want the I Ching to read?",
    requiresQuestion: true,
  }),
  Object.freeze({
    id: "odv-lindy",
    name: "ODV",
    tagline: "Long-horizon alignment and strategic judgment.",
    inputPlaceholder: "What do you want ODV to think through?",
  }),
  Object.freeze({
    id: "sprint-planner",
    name: "Sprint Planner",
    tagline: "Convert context into a focused execution sprint.",
    inputPlaceholder: "What outcome should this sprint produce?",
  }),
  Object.freeze({
    id: "validator",
    name: "Validator",
    tagline: "Operate and troubleshoot Post Fiat validators.",
    inputPlaceholder: "What validator do you need to run or troubleshoot?",
  }),
  Object.freeze({
    id: "post-fiat-qa",
    name: "Post Fiat Q&A",
    tagline: "Get clear answers about Post Fiat concepts.",
    inputPlaceholder: "What do you want to understand about Post Fiat?",
  }),
]);

const chatPersonaDefinitions = Object.freeze([...CHAT_PERSONAS, ...CHAT_MODALITIES]);
const chatPersonaIds = new Set(chatPersonaDefinitions.map((persona) => persona.id));
const chatModalityIds = new Set(CHAT_MODALITIES.map((modality) => modality.id));

export function normalizeChatPersona(value = "", { fallback = DEFAULT_CHAT_PERSONA } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "coach") return "trading-coach";
  if (normalized === "steve-jobs" || normalized === "steve_jobs") return "jobs";
  if (normalized === "henry-kravis" || normalized === "henry_kravis") return "kravis";
  if (normalized === "brainstorm") return "brainstorming";
  if (normalized === "five_mirrors") return "five-mirrors";
  if (normalized === "i_ching") return "i-ching";
  if (normalized === "odv-lindy-alignment") return "odv-lindy";
  if (normalized === "post-fiat" || normalized === "post-fiat-clarity") return "post-fiat-qa";
  return chatPersonaIds.has(normalized) ? normalized : "";
}

export function chatPersonaDefinition(value = "") {
  const id = normalizeChatPersona(value);
  return chatPersonaDefinitions.find((persona) => persona.id === id) || CHAT_PERSONAS.find((persona) => persona.id === DEFAULT_CHAT_PERSONA);
}

export function chatPersonaIsModality(value = "") {
  return chatModalityIds.has(normalizeChatPersona(value, { fallback: "" }));
}

export function chatPersonaUsesJobsRetrieval(value = "") {
  return normalizeChatPersona(value) === "jobs";
}
