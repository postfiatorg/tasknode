export const CHAT_STREAM_HEARTBEAT_MS = 15_000;

export function startChatStreamHeartbeat(
  res,
  {
    intervalMs = CHAT_STREAM_HEARTBEAT_MS,
    now = Date.now,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}
) {
  const startedAt = now();
  let stopped = false;

  const pulse = () => {
    if (stopped || res?.destroyed || res?.writableEnded) return false;
    res.write("event: progress\n");
    res.write(`data: ${JSON.stringify({
      ok: true,
      phase: "thinking",
      elapsedMs: Math.max(0, now() - startedAt),
    })}\n\n`);
    return true;
  };

  const timer = setIntervalImpl(pulse, Math.max(1_000, Number(intervalMs) || CHAT_STREAM_HEARTBEAT_MS));
  timer?.unref?.();

  return {
    pulse,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(timer);
    },
  };
}
