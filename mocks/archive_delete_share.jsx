import { useState } from "react";
import {
  Upload,
  UserPlus,
  Pencil,
  Pin,
  Archive,
  Trash2,
  X,
  Link2,
  MoreHorizontal,
  FileText,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Dropdown menu (Image 1)                                            */
/* ------------------------------------------------------------------ */

function ChatItemMenu() {
  const items = [
    { icon: Upload, label: "Share" },
    { icon: UserPlus, label: "Start a group chat" },
    { icon: Pencil, label: "Rename" },
    { divider: true },
    { icon: Pin, label: "Pin chat" },
    { icon: Archive, label: "Archive", active: true },
    { icon: Trash2, label: "Delete", danger: true },
  ];

  return (
    <div className="w-64 rounded-2xl bg-white py-2 shadow-[0_8px_32px_rgba(0,0,0,0.12)] ring-1 ring-black/5">
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} className="my-1 h-px bg-gray-200/70" />
        ) : (
          <button
            key={i}
            className={[
              "flex w-full items-center gap-3 px-4 py-2.5 text-[15px] transition-colors",
              item.active ? "bg-gray-100" : "hover:bg-gray-50",
              item.danger ? "text-red-500" : "text-gray-900",
            ].join(" ")}
          >
            <item.icon
              className="h-5 w-5 shrink-0"
              strokeWidth={1.75}
            />
            <span>{item.label}</span>
          </button>
        )
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar list + dropdown overlay                                    */
/* ------------------------------------------------------------------ */

function ChatSidebar() {
  const chats = [
    { title: "Steve Jobs Speech Guide", selected: true },
    { title: "Steve Jobs iPhone Launch" },
    { title: "Steve Jobs iPod Strategy" },
    { title: "Steve Jobs Business Principle" },
    { title: "Steve Jobs Business Principle" },
    { title: "Steve Jobs Business Principle" },
    { title: "Steve Jobs Business Principle" },
    { title: "Steve Jobs Business Insights" },
  ];

  return (
    <div className="relative w-[420px]">
      <ul className="space-y-0.5">
        {chats.map((chat, i) => (
          <li
            key={i}
            className={[
              "group flex items-center justify-between rounded-xl px-3 py-2.5 text-[15px] text-gray-900",
              chat.selected ? "bg-gray-100" : "hover:bg-gray-50",
            ].join(" ")}
          >
            <span className="truncate">{chat.title}</span>
            {chat.selected && (
              <MoreHorizontal className="h-4 w-4 text-gray-700" />
            )}
          </li>
        ))}
      </ul>

      {/* Floating menu, anchored to the selected row */}
      <div className="absolute left-[180px] top-[28px] z-10">
        <ChatItemMenu />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Brand glyphs for share buttons                                     */
/* ------------------------------------------------------------------ */

const XGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const LinkedInGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.38-1.85 3.61 0 4.28 2.38 4.28 5.47zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12M7.12 20.45H3.56V9h3.56zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0" />
  </svg>
);

const RedditGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 0C5.373 0 0 5.373 0 12c0 6.628 5.373 12 12 12 6.628 0 12-5.372 12-12 0-6.627-5.372-12-12-12m5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.1 3.1 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.76 1.76 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.39.39 0 0 1 .463-.295l2.906.617a1.25 1.25 0 0 1 1.024-.645zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.32.32 0 0 0-.226.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.34.34 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.32.32 0 0 0-.237-.095z" />
  </svg>
);

/* ------------------------------------------------------------------ */
/*  Share modal (Image 2)                                              */
/* ------------------------------------------------------------------ */

function ShareModal({ onClose }) {
  const shareTargets = [
    { Icon: Link2, label: "Copy link" },
    { Icon: XGlyph, label: "X" },
    { Icon: LinkedInGlyph, label: "LinkedIn" },
    { Icon: RedditGlyph, label: "Reddit" },
  ];

  return (
    <div className="w-full max-w-2xl rounded-3xl bg-white p-8 shadow-2xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <h2 className="text-3xl font-bold tracking-tight text-gray-900">
          Steve Jobs Speech Guide
        </h2>
        <button
          onClick={onClose}
          className="rounded-full p-1 text-gray-700 hover:bg-gray-100"
          aria-label="Close"
        >
          <X className="h-6 w-6" strokeWidth={1.75} />
        </button>
      </div>

      <div className="my-6 h-px bg-gray-200" />

      {/* Conversation preview */}
      <div className="relative overflow-hidden rounded-2xl bg-gray-50 p-6">
        <div className="flex flex-col items-end gap-3">
          {/* Attachment chip */}
          <div className="flex max-w-sm items-center gap-3 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500">
              <FileText
                className="h-5 w-5 text-white"
                strokeWidth={1.75}
              />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-gray-900">
                Pasted text(9).txt
              </div>
              <div className="text-sm text-gray-500">Document</div>
            </div>
          </div>

          {/* User message bubble (clipped with fade) */}
          <div className="relative max-w-md">
            <div className="rounded-3xl bg-black px-5 py-4 text-[15px] leading-relaxed text-white">
              My goal is to make the canonical Steve Jobs prompt. Your job
              is to take this 195 pages of text and create a speech guide.
              How does Steve talk? the goal is to make a very accurate
              style guide for Jobs speech. it shouldn't just be quotes, it
              should be rhetorical structure / the style of communication,
              everything. keep the reasoning 2-3 pages long and the actual
              condensed style guide within 1 8x11 piece of paper
            </div>
            {/* Fade to background at the bottom of the bubble */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 rounded-b-3xl bg-gradient-to-b from-transparent to-gray-50" />
          </div>
        </div>

        {/* Watermark */}
        <div className="absolute bottom-4 right-6 text-2xl font-bold tracking-tight text-black">
          ChatGPT
        </div>
      </div>

      {/* Share targets */}
      <div className="mt-8 flex justify-center gap-10">
        {shareTargets.map(({ Icon, label }) => (
          <button
            key={label}
            className="group flex flex-col items-center gap-2"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black text-white transition-transform group-hover:scale-105">
              <Icon className="h-6 w-6" />
            </span>
            <span className="text-sm font-medium text-gray-900">
              {label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Demo wrapper                                                       */
/* ------------------------------------------------------------------ */

export default function ChatShareUI() {
  const [view, setView] = useState("menu"); // "menu" | "share"

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-100 to-gray-200 p-8 font-sans">
      {/* Toggle */}
      <div className="mx-auto mb-8 flex w-fit gap-1 rounded-full bg-white p-1 shadow-sm">
        {[
          { id: "menu", label: "Dropdown menu" },
          { id: "share", label: "Share modal" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={[
              "rounded-full px-5 py-2 text-sm font-medium transition-colors",
              view === t.id
                ? "bg-black text-white"
                : "text-gray-700 hover:bg-gray-50",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Stage */}
      <div className="flex justify-center">
        {view === "menu" ? (
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <ChatSidebar />
          </div>
        ) : (
          <ShareModal onClose={() => setView("menu")} />
        )}
      </div>
    </div>
  );
}