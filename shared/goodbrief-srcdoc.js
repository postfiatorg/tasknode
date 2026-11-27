// Goodbrief HTML is untrusted. It renders inside `<iframe sandbox="allow-scripts">`
// via `srcdoc`, in a document whose head this code writes: the content policy is
// the first thing the parser sees, whatever the untrusted markup contains
// (comments, a second <head>, a missing <head>), and the markup only ever lands
// in <body>, where a CSP <meta> has no effect.

export const GOODBRIEF_SANDBOX_ATTR = "allow-scripts";
export const GOODBRIEF_SRCDOC_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const RESOURCE_ATTRS = /\s(?:src|srcset|poster|background|data|action|formaction|ping|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

function escapeAttr(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Defense in depth under the policy: drop tags that redirect, nest frames or load
// code, and any resource address that is not inline data.
function stripActiveContent(html) {
  return html
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*\bhref\s*=\s*["']?https?:[^>]*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(RESOURCE_ATTRS, (attr, dq, sq, bare) =>
      /^\s*data:/i.test(dq ?? sq ?? bare ?? "") ? attr : ""));
}

export function buildGoodbriefSrcDoc(rawHtml = "", { watermarkId = "", title = "Goodbrief", footer = "" } = {}) {
  const body = stripActiveContent(String(rawHtml || ""));
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(GOODBRIEF_SRCDOC_CSP)}">`;
  const wmMeta = watermarkId ? `<meta name="pf-fh-wm" content="${escapeAttr(watermarkId)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta}${wmMeta}<title>${escapeAttr(title)}</title></head><body>${body}${footer}</body></html>`;
}
