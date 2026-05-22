import React, { useEffect, useMemo, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { copyText } from "../chat/ChatMessages.jsx";
import { buildTaskCopyPayloads, copyPreview } from "./task-copy-format.js";
import "./task-copy.css";

const COPY_OPTIONS = [
  {
    key: "title",
    label: "Copy title",
    doneLabel: "Title copied.",
    description: "Just the task title.",
  },
  {
    key: "summary",
    label: "Copy summary",
    doneLabel: "Summary copied.",
    description: "Title, status, reward, deadline, and short description.",
  },
  {
    key: "full",
    label: "Copy full task",
    doneLabel: "Full task copied.",
    description: "Readable task payload with steps and verification requirement.",
  },
];

export function TaskCopyModal({ onClose, task }) {
  const [copiedKey, setCopiedKey] = useState("");
  const [message, setMessage] = useState("");
  const payloads = useMemo(() => buildTaskCopyPayloads(task), [task]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose?.();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function copyPayload(key) {
    const ok = await copyText(payloads[key]);
    if (!ok) {
      setMessage("Copy failed.");
      return;
    }
    const option = COPY_OPTIONS.find((item) => item.key === key);
    const doneMessage = option?.doneLabel || "Task copied.";
    setCopiedKey(key);
    setMessage(doneMessage);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? "" : current));
      setMessage((current) => (current === doneMessage ? "" : current));
    }, 1400);
  }

  return (
    <div className="modal-backdrop task-copy-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="task-copy-title"
        aria-modal="true"
        className="task-copy-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <span className="task-copy-kicker">
              <Copy size={13} strokeWidth={1.75} />
              Copy task
            </span>
            <h2 id="task-copy-title">{task?.title || "Untitled task"}</h2>
          </div>
          <button aria-label="Close copy task" className="task-copy-close" onClick={onClose} type="button">
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>

        <div className="task-copy-options">
          {COPY_OPTIONS.map((option) => {
            const copied = copiedKey === option.key;
            return (
              <button
                className={copied ? "task-copy-option is-copied" : "task-copy-option"}
                key={option.key}
                onClick={() => copyPayload(option.key)}
                type="button"
              >
                <span className="task-copy-option-icon">
                  {copied ? <Check size={14} strokeWidth={1.9} /> : <Copy size={14} strokeWidth={1.75} />}
                </span>
                <span>
                  <strong>{copied ? "Copied" : option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            );
          })}
        </div>

        <div className="task-copy-preview">
          <span>Full task preview</span>
          <pre>{copyPreview(payloads.full, 720)}</pre>
        </div>

        <p className={message ? "task-copy-ack is-visible" : "task-copy-ack"}>{message || "Ready to copy."}</p>
      </section>
    </div>
  );
}
