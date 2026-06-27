export function shouldShowIndexedTaskEventsLoading({ detail = null, loading = false } = {}) {
  if (!loading) return false;
  return !detail?.task && !detail?.forensics;
}

export function taskForensicsTimeline(forensics = {}) {
  const pointerTimeline = Array.isArray(forensics?.timeline) ? forensics.timeline : [];
  const reducerEvents = Array.isArray(forensics?.reducerEvents) ? forensics.reducerEvents : [];
  return pointerTimeline.length ? pointerTimeline : reducerEvents;
}

export function taskForensicsExpectedEventCount(forensics = {}) {
  const integrity = forensics?.integrity || {};
  return Number(forensics?.eventCount || integrity.expectedEventCount || 0);
}

export function taskForensicsIndexedEventLabel({ indexedCount = 0, expectedCount = 0 } = {}) {
  const indexed = Math.max(0, Number(indexedCount || 0));
  const expected = Math.max(0, Number(expectedCount || 0));
  if (expected > indexed) return `${indexed} / ${expected} indexed`;
  return `${indexed} indexed`;
}

export function taskForensicsIndexedEventCount({ detail = null, task = null } = {}) {
  const forensics = detail?.forensics || null;
  if (forensics && !detail?.partial) return taskForensicsTimeline(forensics).length;
  return Number(task?.metadata?.eventCount || forensics?.eventCount || 0);
}
