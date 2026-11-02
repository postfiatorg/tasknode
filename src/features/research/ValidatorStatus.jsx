import { Server } from "lucide-react";
import { validatorMenuStatus, validatorTooltip } from "../../../shared/validator-display.js";
import "./validator-status.css";

export function ValidatorMark({ bindings = [], avatar = false }) {
  if (!bindings.length) return null;
  const label = validatorTooltip(bindings);
  return <span className={avatar ? "validator-avatar-mark" : "validator-mark"} title={label} aria-label={label}>
    <Server size={avatar ? 11 : 14} aria-hidden="true" />{!avatar && <span>Validator</span>}
  </span>;
}

export function ValidatorAvatar({ bindings = [], children }) {
  return <span className="validator-avatar">{children}<ValidatorMark bindings={bindings} avatar /></span>;
}

export function ValidatorMenuLink({ bindings = [], onClick }) {
  return <a className="tool-menu-row" href="#settings/validator" onClick={onClick}>
    <Server size={16} aria-hidden="true" /><span>Validator</span>
    <small className={`validator-menu-status${bindings.length ? " is-connected" : ""}`}>{validatorMenuStatus(bindings)}</small>
  </a>;
}
