import React from "react";
import { ArrowUp } from "lucide-react";

export function ComposerSendButton({
  ariaLabel = "Send",
  className = "",
  disabled = false,
  title,
} = {}) {
  return (
    <button
      aria-label={ariaLabel}
      className={`send-button app-composer-send-button${className ? ` ${className}` : ""}`}
      disabled={disabled}
      title={title}
      type="submit"
    >
      <ArrowUp size={18} strokeWidth={2.25} />
    </button>
  );
}
