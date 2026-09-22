import { X } from "lucide-react";

export function ComposerModeChip({ exitLabel, icon: Icon, label, onExit }) {
  return (
    <div className="composer-mode-chip">
      <Icon size={13} strokeWidth={1.9} />
      <span>{label}</span>
      {onExit && (
        <button aria-label={`Exit ${exitLabel || label}`} onClick={onExit} type="button">
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
