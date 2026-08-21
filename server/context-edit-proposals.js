import { contextDocumentPacket, sha256Text } from "./context-line-map.js";

export const contextEditOperations = new Set([
  "replace_block",
  "replace_section",
  "append_to_section",
  "replace_document",
  "append_document",
]);

function cleanText(value = "", max = 24000) {
  return String(value || "").trim().slice(0, max);
}

function cleanInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : null;
}

function problem(message, status = 400, code = "context_edit_invalid_proposal") {
  const error = new Error(code);
  error.status = status;
  error.userMessage = message;
  return error;
}

export function parseContextEditOutput(text = "") {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw problem(
      "The context editor returned an invalid structured response. Retry the edit request.",
      502,
      "context_edit_invalid_json"
    );
  }

  const state = parsed?.state === "proposal" ? "proposal" : "needs_calibration";
  const response = cleanText(parsed?.response, 3000);
  const proposalInput = parsed?.proposal && typeof parsed.proposal === "object" ? parsed.proposal : null;
  if (state !== "proposal") return { response, state, proposal: null };
  if (!proposalInput) {
    throw problem("The context editor did not include a proposal to review.", 502);
  }

  const proposal = {
    operation: cleanText(proposalInput.operation, 80),
    anchorType: cleanText(proposalInput.anchor_type || proposalInput.anchorType, 80),
    lineStart: cleanInt(proposalInput.line_start ?? proposalInput.lineStart),
    lineEnd: cleanInt(proposalInput.line_end ?? proposalInput.lineEnd),
    targetHeading: cleanText(proposalInput.target_heading || proposalInput.targetHeading, 1000),
    targetBefore: cleanText(proposalInput.target_before || proposalInput.targetBefore, 12000),
    targetAfter: cleanText(proposalInput.target_after || proposalInput.targetAfter, 24000),
    rationale: cleanText(proposalInput.rationale, 2000),
    risk: ["low", "medium", "high"].includes(proposalInput.risk) ? proposalInput.risk : "low",
  };

  if (!contextEditOperations.has(proposal.operation)) {
    throw problem("The context editor proposed an unsupported edit operation.", 502);
  }
  if (!proposal.targetAfter) {
    throw problem("The context editor proposed an empty replacement.", 502);
  }
  if (["replace_block", "replace_section"].includes(proposal.operation) && !proposal.targetBefore) {
    throw problem("The context editor must include the exact current text before replacing it.", 502);
  }
  return { response, state, proposal };
}

function headingText(value = "") {
  return String(value || "").replace(/^#{1,6}\s+/, "").trim();
}

function findHeadingLine(lines, targetHeading = "") {
  const target = headingText(targetHeading);
  if (!target) return -1;
  return lines.findIndex((line) => headingText(line) === target);
}

function replaceExactBlock(bodyText, targetBefore, targetAfter) {
  const index = bodyText.indexOf(targetBefore);
  if (index === -1) {
    throw problem(
      "The proposed edit is stale because the target text no longer exists in the current context document.",
      409,
      "context_edit_stale"
    );
  }
  return `${bodyText.slice(0, index)}${targetAfter}${bodyText.slice(index + targetBefore.length)}`.trim();
}

function appendToSection(bodyText, targetHeading, targetAfter) {
  const lines = bodyText.split("\n");
  const headingIndex = findHeadingLine(lines, targetHeading);
  if (headingIndex === -1) {
    throw problem(
      "The proposed edit is stale because the target section no longer exists in the current context document.",
      409,
      "context_edit_stale"
    );
  }

  let insertIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("#") && headingText(line)) {
      insertIndex = index;
      break;
    }
  }
  return [
    ...lines.slice(0, insertIndex),
    "",
    targetAfter,
    ...lines.slice(insertIndex),
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function applyContextEditProposalToDocument({ document = {}, proposal = {} } = {}) {
  const packet = contextDocumentPacket(document);
  const bodyText = packet.bodyText;
  const baseRevision = Number(proposal.baseContextRevision || 0);
  const baseHash = String(proposal.baseBodySha256 || "");

  if (baseRevision !== packet.revision || baseHash !== packet.bodySha256) {
    throw problem(
      "The context document changed after this proposal was generated. Regenerate the edit against the latest document.",
      409,
      "context_edit_stale"
    );
  }

  let patchedText;
  switch (proposal.operation) {
    case "replace_document":
      patchedText = proposal.targetAfter;
      break;
    case "append_document":
      patchedText = [bodyText, proposal.targetAfter].filter(Boolean).join("\n\n");
      break;
    case "replace_block":
    case "replace_section":
      patchedText = replaceExactBlock(bodyText, proposal.targetBefore, proposal.targetAfter);
      break;
    case "append_to_section":
      patchedText = appendToSection(bodyText, proposal.targetHeading, proposal.targetAfter);
      break;
    default:
      throw problem("The proposal operation is not supported.", 400);
  }

  return {
    title: document?.title || "Task Node Context",
    body: patchedText.trim(),
    bodySha256: sha256Text(patchedText.trim()),
  };
}
