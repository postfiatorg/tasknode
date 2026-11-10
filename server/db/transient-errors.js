export function transientDatabaseError(error) {
  return error?.message === "Query read timeout" ||
    ["57014", "40001", "40P01", "ECONNRESET", "EPIPE", "08006", "57P01"].includes(error?.code);
}
