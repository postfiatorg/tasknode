import React, { useEffect, useState } from "react";
import { Lock, X } from "lucide-react";
import { requestJson } from "../../api";

const EMPTY_FORM = {
  birthDate: "",
  birthTime: "",
  birthLocation: "",
  gender: "",
};

export function IChingSetupDialog({ onCancel, onSaved, open }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    setError("");
    const closeOnEscape = (event) => {
      if (event.key === "Escape" && !saving) onCancel?.();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, open, saving]);

  if (!open) return null;

  function update(field) {
    return (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await requestJson("/api/i-ching/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!result.ok || !result.body?.exists) {
        throw new Error(result.body?.message || `I Ching setup returned HTTP ${result.status}.`);
      }
      onSaved?.(result.body.profile);
    } catch (saveError) {
      setError(saveError?.message || "The birth chart could not be generated.");
    } finally {
      setSaving(false);
    }
  }

  const complete = Object.values(form).every((value) => String(value).trim());

  return (
    <div className="dialog-backdrop i-ching-setup-backdrop" role="presentation">
      <section
        aria-labelledby="i-ching-setup-title"
        aria-modal="true"
        className="login-dialog i-ching-setup-dialog"
        role="dialog"
      >
        <button
          aria-label="Cancel I Ching setup"
          className="dialog-close"
          disabled={saving}
          onClick={onCancel}
          type="button"
        >
          <X size={19} strokeWidth={1.8} />
        </button>
        <div className="i-ching-setup-mark" aria-hidden="true">䷀</div>
        <h2 id="i-ching-setup-title">Set up I Ching</h2>
        <p>
          The full reading combines a fresh hexagram with your Bā Zì and Zǐ Wēi chart. Exact birth time
          and place are required to calculate the correct timezone and true solar time.
        </p>
        <form className="i-ching-setup-form" onSubmit={submit}>
          <div className="i-ching-setup-grid">
            <label>
              <span>Birth date</span>
              <input
                autoFocus
                disabled={saving}
                onChange={update("birthDate")}
                required
                type="date"
                value={form.birthDate}
              />
            </label>
            <label>
              <span>Exact birth time</span>
              <input
                disabled={saving}
                onChange={update("birthTime")}
                required
                type="time"
                value={form.birthTime}
              />
            </label>
          </div>
          <label>
            <span>Birth city and country</span>
            <input
              disabled={saving}
              onChange={update("birthLocation")}
              placeholder="Philadelphia, United States"
              required
              type="text"
              value={form.birthLocation}
            />
          </label>
          <label>
            <span>Gender used by the traditional chart</span>
            <select disabled={saving} onChange={update("gender")} required value={form.gender}>
              <option value="">Select</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
          <div className="i-ching-private-note">
            <Lock size={14} strokeWidth={1.9} />
            <span>Private to your Task Node account. It is used only to prepare your readings.</span>
          </div>
          {error && <div className="i-ching-setup-error" role="alert">{error}</div>}
          <div className="i-ching-setup-actions">
            <button className="i-ching-cancel-button" disabled={saving} onClick={onCancel} type="button">
              Cancel
            </button>
            <button className="continue-button" disabled={!complete || saving} type="submit">
              {saving ? "Calculating chart…" : "Create private chart"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
