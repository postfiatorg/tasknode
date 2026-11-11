import { useEffect, useState } from 'react';
import { encryptForTaskNodeWallet } from '../collaboration/collaboration-client';
import { deviceFingerprint } from '../../../packages/tasknode-cli/lib/prompt-device.mjs';
import { promptRequest } from './prompt-library';
export function PromptDevices({ libraryKey, accountId, walletSecret }) {
  const [devices,setDevices] = useState([]);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState('');
  const refresh = () => promptRequest('devices').then(result => setDevices(result.devices)).catch(() => setError('Could not load prompt devices'));
  useEffect(() => { refresh(); const timer = setInterval(refresh,5000); return () => clearInterval(timer); }, []);
  async function act(device, approve) {
    setBusy(device.deviceId); setError('');
    try {
      if (approve) {
        const fingerprint = await deviceFingerprint(device.publicKey);
        if (fingerprint !== device.fingerprint || !libraryKey) throw new Error('Device key could not be verified');
        const envelope = await encryptForTaskNodeWallet({ key:libraryKey, deviceId:device.deviceId, fingerprint, accountId }, [device.publicKey], walletSecret);
        await promptRequest('devices/approve',{deviceId:device.deviceId,envelope});
      } else await promptRequest('devices/revoke',{deviceId:device.deviceId});
      await refresh();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }
  const active = devices.filter(device => !device.revokedAt);
  if (!active.length && !error) return null;
  return <section className="prompt-stats" aria-label="Prompt devices"><h2>Prompt devices</h2><p>Match the fingerprint shown by your agent before approving access to your encrypted prompt library.</p>{active.map(device => <div key={device.deviceId}><strong>{device.label}</strong><p style={{overflowWrap:'anywhere'}}>Fingerprint: {device.fingerprint}</p>{!device.approvedAt && <button disabled={Boolean(busy) || !libraryKey} onClick={() => act(device,true)}>Approve prompt access</button>}<button disabled={Boolean(busy)} onClick={() => act(device,false)}>Revoke prompt access</button></div>)}{error && <p role="alert">{error}</p>}</section>;
}
