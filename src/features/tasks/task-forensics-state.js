export function shouldShowIndexedTaskEventsLoading({ detail = null, loading = false } = {}) {
  if (!loading) return false;
  return !detail?.task && !detail?.forensics;
}
