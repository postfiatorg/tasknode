import { useState, useRef, useEffect } from "react";
import {
  Plus,
  ArrowUp,
  ChevronDown,
  X,
  ChevronRight,
  FileText,
} from "lucide-react";

/**
 * ChatComposer
 * ------------
 * Demonstrates the three states of the chat input and the transitions between them:
 *
 *   1. Empty           → toolbar is a single inline row: [+  Ask anything  Instant  🎤  ↑]
 *   2. Pasted          → an attachment pill sits above the toolbar; toolbar stays inline
 *   3. Expanded        → the textarea breaks onto its own row above the toolbar
 *
 * The layout swap (inline ↔ stacked) is done with CSS Grid template-areas so the
 * <textarea> element stays mounted across state changes — that means typing the
 * very first character doesn't blur the input or drop the keystroke.
 *
 * Long pastes (>200 chars) are converted into an attachment pill instead of inline text,
 * mirroring the behavior in the reference screenshots.
 */

const DEMO_TEXT = `separator and active / danger flags for the highlighted Archive row and the red Delete row. Easy to reorder or extend.

ChatSidebar absolutely-positions the menu over the selected row to match the screenshot. In production you'd anchor it to the three-dot button with something like Radix DropdownMenu or Floating UI rather than hard-coded offsets.

ShareModal uses a gradient overlay (from-transparent to-gray-50) on the bottom of the black bubble to recreate that fade-out effect from the screenshot, instead of trying to fade the text itself.

Brand glyphs (X, LinkedIn, Reddit) aren't in lucide, so I inlined them as small SVG components. The Copy link button uses lucide's Link2.

The toggle at the top of ChatShareUI is just demo scaffolding so you can flip between the two views — drop it when you wire this into your real app.`;

const DEMO_ATTACHMENT = { name: "import { useState } .." };

const PASTE_THRESHOLD = 200; // chars; longer pastes become a pill
const MAX_TEXTAREA_HEIGHT = 220; // px before internal scroll kicks in

export default function ChatComposer() {
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState(null);
  const textareaRef = useRef(null);

  const isExpanded = text.length > 0;

  // Auto-grow the textarea up to MAX_TEXTAREA_HEIGHT, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
  }, [text, isExpanded]);

  const handlePaste = (e) => {
    const pasted = e.clipboardData.getData("text");
    if (pasted.length > PASTE_THRESHOLD && !attachment) {
      e.preventDefault();
      const firstLine =
        pasted.split("\n").find((l) => l.trim()) || "Pasted content";
      const trimmed = firstLine.trim();
      setAttachment({
        name: trimmed.slice(0, 28) + (trimmed.length > 28 ? " .." : ""),
      });
    }
  };

  const send = () => {
    if (!text && !attachment) return;
    // Replace with your real submit handler.
    console.log("send", { text, attachment });
    setText("");
    setAttachment(null);
  };

  const canSend = text.length > 0 || attachment !== null;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-8 font-sans">
      {/*
        Grid trick — same DOM tree, two layouts.
        Compact:  [plus] [textarea] [tools]                  (one row)
        Expanded: [textarea . . .]                           (full-width row)
                  [plus] [gap]      [tools]                  (toolbar below)
      */}
      <style>{`
        .composer-grid {
          display: grid;
          align-items: center;
          gap: 10px;
          grid-template-columns: auto 1fr auto;
        }
        .composer-grid.is-compact {
          grid-template-areas: "plus ta tools";
        }
        .composer-grid.is-expanded {
          grid-template-areas:
            "ta ta    ta"
            "plus gap tools";
        }
        .ga-plus  { grid-area: plus; }
        .ga-ta    { grid-area: ta; }
        .ga-tools { grid-area: tools; justify-self: end; }
      `}</style>

      <div className="w-full max-w-2xl">
        {/* Demo controls — flip between the three states without typing */}
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-500 mr-1">Load state:</span>
          <button
            onClick={() => {
              setText("");
              setAttachment(null);
            }}
            className="px-3 py-1.5 text-sm rounded-full border border-gray-200 hover:bg-gray-100 transition"
          >
            Empty
          </button>
          <button
            onClick={() => {
              setText("");
              setAttachment(DEMO_ATTACHMENT);
            }}
            className="px-3 py-1.5 text-sm rounded-full border border-gray-200 hover:bg-gray-100 transition"
          >
            Pill only
          </button>
          <button
            onClick={() => {
              setText(DEMO_TEXT);
              setAttachment(DEMO_ATTACHMENT);
            }}
            className="px-3 py-1.5 text-sm rounded-full border border-gray-200 hover:bg-gray-100 transition"
          >
            Expanded
          </button>
        </div>

        {/* The composer itself */}
        <div className="rounded-[26px] border border-gray-200 bg-white px-4 pt-3 pb-2.5 flex flex-col gap-2.5 shadow-sm">
          {/* Attachment pill — sized to content, not stretched full-width */}
          {attachment && (
            <div
              style={{
                alignSelf: "flex-start",
                width: "fit-content",
                maxWidth: 360,
              }}
              className="flex items-center gap-3 rounded-2xl border border-gray-200 pl-2 pr-2.5 py-2"
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 9,
                  backgroundColor: "#2D7FF9",
                }}
                className="flex-shrink-0 text-white flex items-center justify-center"
              >
                <FileText size={20} strokeWidth={1.75} />
              </div>
              <div className="flex-1 min-w-0 leading-tight pr-2">
                <div
                  style={{ fontSize: 14 }}
                  className="font-medium text-gray-900 truncate"
                >
                  {attachment.name}
                </div>
                <button
                  style={{ fontSize: 13 }}
                  className="text-gray-500 underline underline-offset-2 inline-flex items-center gap-0.5 hover:text-gray-700"
                >
                  Show in text field <ChevronRight size={12} />
                </button>
              </div>
              <button
                onClick={() => setAttachment(null)}
                style={{ width: 22, height: 22 }}
                className="flex-shrink-0 rounded-full bg-black text-white flex items-center justify-center hover:bg-gray-800 transition"
                aria-label="Remove attachment"
              >
                <X size={13} strokeWidth={3} />
              </button>
            </div>
          )}

          {/* The grid that swaps layout when isExpanded flips */}
          <div
            className={
              "composer-grid " + (isExpanded ? "is-expanded" : "is-compact")
            }
          >
            <button
              className="ga-plus w-[30px] h-[30px] flex items-center justify-center text-gray-900 hover:bg-gray-100 rounded-full transition"
              aria-label="Add"
            >
              <Plus size={22} strokeWidth={2} />
            </button>

            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={isExpanded ? "" : "Ask anything"}
              rows={1}
              className="ga-ta resize-none border-0 outline-none bg-transparent text-[15px] leading-[1.55] text-gray-900 placeholder:text-gray-400 py-1 px-0.5 w-full overflow-y-auto"
              style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
            />

            <div className="ga-tools flex items-center gap-2.5">
              <button className="inline-flex items-center gap-0.5 text-gray-500 text-[14px] hover:text-gray-700 transition">
                Instant <ChevronDown size={14} />
              </button>
              <button
                onClick={send}
                disabled={!canSend}
                className="w-[32px] h-[32px] rounded-full bg-black text-white flex items-center justify-center hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
                aria-label="Send"
              >
                <ArrowUp size={17} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>

        <p className="text-center text-[13px] text-gray-500 mt-3">
          ChatGPT can make mistakes. Check important info. See{" "}
          <span className="underline">Cookie Preferences</span>.
        </p>

        {/* Usage notes for the developer */}
        <div className="mt-10 text-sm text-gray-500 leading-relaxed">
          <p className="font-medium text-gray-700 mb-1">Try it:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Type to watch the textarea break out of the inline row</li>
            <li>
              Paste 200+ chars to trigger the attachment pill instead of inline
              text
            </li>
            <li>Click X on the pill to remove it</li>
            <li>Use the buttons above to jump between states without typing</li>
          </ul>
        </div>
      </div>
    </div>
  );
}