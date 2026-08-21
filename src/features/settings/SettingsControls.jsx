import { useState } from "react";

export function SettingsLine({ danger, desc, label, right }) {
  return (
    <div className={danger ? "settings-line danger" : "settings-line"}>
      <div>
        <strong>{label}</strong>
        {desc && <p>{desc}</p>}
      </div>
      {right}
    </div>
  );
}

export function SmallPill({ children, danger, disabled, onClick }) {
  return (
    <button className={danger ? "small-pill danger" : "small-pill"} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}

export function ToggleSwitch({ checked, disabled = false, initial, onChange }) {
  const controlled = checked !== undefined;
  const [on, setOn] = useState(Boolean(initial));
  const value = controlled ? Boolean(checked) : on;
  function toggle() {
    if (disabled) return;
    const nextValue = !value;
    if (!controlled) setOn(nextValue);
    onChange?.(nextValue);
  }
  return (
    <button
      aria-pressed={value}
      className={value ? "toggle-switch on" : "toggle-switch"}
      disabled={disabled}
      onClick={toggle}
      type="button"
    >
      <span />
    </button>
  );
}
