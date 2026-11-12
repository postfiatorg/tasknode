const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export function promptStats(events, { days = 7, now = Date.now() } = {}) {
  if (![7, 30].includes(days)) throw new Error("Choose 7 or 30 days");
  const end = Date.parse(dayOf(now));
  const rows = new Map(
    Array.from({ length: days }, (_, i) => [
      dayOf(end - (days - i - 1) * 86400000),
      { created: 0, versions: 0, activeSeconds: 0 },
    ]),
  );
  const seen = new Set();
  const sessions = new Map();
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const at = Date.parse(event.at || event.createdAt);
    if (!Number.isFinite(at) || at > now) continue;
    const row = rows.get(dayOf(at));
    if (row && event.kind === "created") row.created++;
    if (row && event.kind === "version_saved") row.versions++;
    if (event.kind === "edit_session") {
      const id = `${event.documentId}:${event.sessionId || event.eventId}`;
      const prior = sessions.get(id);
      if (!prior || Date.parse(event.end) >= Date.parse(prior.end)) sessions.set(id, event);
    }
  }
  for (const session of sessions.values()) {
    const daily = session.activeByDay || { [dayOf(Date.parse(session.start))]: session.activeSeconds };
    for (const [day, seconds] of Object.entries(daily)) {
      const row = rows.get(day);
      if (row && Number.isFinite(seconds) && seconds >= 0) row.activeSeconds += seconds;
    }
  }
  const daily = [...rows].map(([day, row]) => ({ day, ...row, activeMinutes: row.activeSeconds / 60 }));
  return {
    timezone: "UTC",
    days,
    daily,
    totals: daily.reduce(
      (sum, row) => ({
        created: sum.created + row.created,
        versions: sum.versions + row.versions,
        activeSeconds: sum.activeSeconds + row.activeSeconds,
        activeMinutes: (sum.activeSeconds + row.activeSeconds) / 60,
      }),
      { created: 0, versions: 0, activeSeconds: 0, activeMinutes: 0 },
    ),
  };
}

// Count seconds containing local input, not wall time with an editor open.
// Checkpoints use the same sessionId; stats count only the latest checkpoint.
export function createPromptActivity({ emit, now = Date.now, uuid = () => crypto.randomUUID() }) {
  let session = null;
  function snapshot(ended = false) {
    if (!session) return;
    const activeByDay = {};
    for (const second of session.seconds) {
      const day = dayOf(second * 1000);
      activeByDay[day] = (activeByDay[day] || 0) + 1;
    }
    const event = {
      kind: "edit_session",
      sessionId: session.id,
      start: new Date(session.start).toISOString(),
      end: new Date(session.last).toISOString(),
      activeSeconds: session.seconds.size,
      activeByDay,
      ended,
    };
    if (ended) session = null;
    return emit(event);
  }
  return {
    input() {
      const at = now();
      if (session && at - session.last > 120000) snapshot(true);
      session ||= { id: uuid(), start: at, last: at, seconds: new Set() };
      session.last = at;
      session.seconds.add(Math.floor(at / 1000));
    },
    tick() {
      return session && snapshot(now() - session.last > 120000);
    },
    close() {
      return snapshot(true);
    },
  };
}
