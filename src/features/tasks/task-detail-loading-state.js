export function taskDetailControlsBlocked(detailState = {}) {
  return Boolean(detailState?.loading && !detailState?.data);
}

export function taskDetailRefreshErrorState(current = {}, error = "task_detail_unavailable") {
  if (current?.data?.task) {
    return {
      ...current,
      error,
      loading: false,
    };
  }
  return {
    data: null,
    error,
    loading: false,
  };
}
