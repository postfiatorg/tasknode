import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { encryptForTaskNodeWallet } from "../collaboration/collaboration-client";
import { deviceFingerprint, promptPairingCode } from "../../../packages/tasknode-cli/lib/prompt-device.mjs";
import { promptRequest } from "./prompt-library";

export function PromptDevices({ libraryKey, accountId, walletSecret }) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState("");
  const dialogRef = useRef(null);
  const buttonRef = useRef(null);
  const refresh = useCallback(async () => {
    try {
      const result = await promptRequest("devices");
      setDevices(result.devices);
    } catch {
      setError("Could not load prompt devices.");
    }
  }, []);

  useEffect(() => {
    if (!open) {
      dialogRef.current?.close();
      return;
    }
    dialogRef.current?.showModal();
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  async function act(device, approve) {
    setBusy(device.deviceId);
    setError("");
    try {
      if (approve) {
        const fingerprint = await deviceFingerprint(device.publicKey);
        if (fingerprint !== device.fingerprint || !libraryKey) throw new Error("Device key could not be verified");
        const envelope = await encryptForTaskNodeWallet(
          { key: libraryKey, deviceId: device.deviceId, fingerprint, accountId },
          [device.publicKey],
          walletSecret,
        );
        await promptRequest("devices/approve", { deviceId: device.deviceId, envelope });
        setPairing({ deviceId: device.deviceId, code: await promptPairingCode(libraryKey, { ...device, accountId }) });
      } else {
        setPairing(null);
        await promptRequest("devices/revoke", { deviceId: device.deviceId });
      }
      await refresh();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy("");
    }
  }

  const active = devices.filter((device) => !device.revokedAt);
  return (
    <>
      <button ref={buttonRef} type="button" onClick={() => setOpen(true)}>
        <KeyRound size={13} />
        Agent access
      </button>
      <dialog
        ref={dialogRef}
        className="docs-folder-dialog prompt-devices-dialog"
        aria-labelledby="prompt-devices-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <section aria-label="Prompt devices">
          <header className="prompt-section-heading">
            <h2 id="prompt-devices-title">Agent access</h2>
            <button type="button" className="docs-refresh-button" aria-label="Close agent access" onClick={close}>
              <X size={18} />
            </button>
          </header>
          <p>Match the fingerprint shown by your agent before approving access to your encrypted prompt library.</p>
          {!active.length && !error && (
            <p>
              No prompt devices yet. Connect your agent from <a href="/connect">Connect an agent</a>.
            </p>
          )}
          {active.map((device) => (
            <article className="prompt-device" key={device.deviceId}>
              <strong>{device.label}</strong>
              <small>{device.approvedAt ? "Prompt access approved" : "Waiting for your approval"}</small>
              <p className="prompt-fingerprint">
                Fingerprint: <code>{device.fingerprint}</code>
              </p>
              <div className="docs-folder-dialog-actions">
                <button type="button" disabled={Boolean(busy)} onClick={() => act(device, false)}>
                  Revoke prompt access
                </button>
                {device.approvedAt && (
                  <button
                    type="button"
                    onClick={async () =>
                      setPairing({
                        deviceId: device.deviceId,
                        code: await promptPairingCode(libraryKey, { ...device, accountId }),
                      })
                    }
                  >
                    Pair local agent
                  </button>
                )}
                {!device.approvedAt && (
                  <button
                    type="button"
                    className="docs-solid-button"
                    disabled={Boolean(busy) || !libraryKey}
                    onClick={() => act(device, true)}
                  >
                    Approve prompt access
                  </button>
                )}
              </div>
            </article>
          ))}
          {pairing && (
            <section className="prompt-pairing" aria-label="Finish agent pairing">
              <h3>Finish pairing on your agent</h3>
              <p>
                Copy this command directly to your local agent. It verifies that the agent received your library key.
              </p>
              <pre
                data-pairing-code={pairing.code}
              >{`tasknode prompts-pair --device-id ${pairing.deviceId} --code ${pairing.code}`}</pre>
            </section>
          )}
          {error && (
            <p className="docs-folder-error" role="alert">
              {error}
            </p>
          )}
        </section>
      </dialog>
    </>
  );
}
