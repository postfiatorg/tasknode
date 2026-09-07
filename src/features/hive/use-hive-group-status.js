import { useEffect, useState } from "react";
import { requestJson } from "../../api.js";
import { HIVE_CHAT_NOTIFICATION_REFRESH_MS } from "../../app/app-shell-shared.jsx";

export function useHiveGroupStatus({ accountId, signedIn, activeChatKind, activeChatId, view }) {
  const [hiveGroupStatus, setHiveGroupStatus] = useState(null);
  useEffect(() => {
    if (!signedIn || !accountId) return undefined;
    let active = true;
    async function refreshHiveNotificationState() {
      try {
        const result = await requestJson("/api/hive/group/status");
        if (!active || !result.ok || !result.body?.ok) return;
        setHiveGroupStatus({ ...result.body, accountId: accountId });
      } catch {
        // Hive notifications are non-blocking; app-state will surface hard failures.
      }
    }
    refreshHiveNotificationState();
    const timer = window.setInterval(refreshHiveNotificationState, HIVE_CHAT_NOTIFICATION_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [accountId, signedIn, activeChatKind, activeChatId, view]);
  return [hiveGroupStatus, setHiveGroupStatus];
}
