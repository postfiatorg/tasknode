import { useMemo } from "react";
import { GOODBRIEF_SANDBOX_ATTR, buildGoodbriefSrcDoc } from "./goodbrief-sandbox.js";

/**
 * Isolated Goodbrief HTML renderer.
 * Uses `<iframe sandbox="allow-scripts">` (opaque origin only) via `srcDoc`
 * with strict zero-exfiltration CSP (`connect-src 'none'`), so third-party or
 * LLM-generated HTML can never access the Task Node origin, session, or wallet.
 */
export function GoodbriefFrame({ html = "", srcDoc = "", title = "Goodbrief Macro Roundup", watermarkId = "" }) {
  const safeSrcDoc = useMemo(() => {
    const source = srcDoc || html;
    if (!source) return "";
    return buildGoodbriefSrcDoc(source, { watermarkId, title });
  }, [html, srcDoc, title, watermarkId]);

  if (!safeSrcDoc) {
    return (
      <div className="finance-hub-empty">
        <p>No Goodbrief edition is currently published for this desk.</p>
      </div>
    );
  }

  return (
    <iframe
      className="finance-hub-goodbrief-frame"
      referrerPolicy="no-referrer"
      sandbox={GOODBRIEF_SANDBOX_ATTR}
      srcDoc={safeSrcDoc}
      title={title}
    />
  );
}
