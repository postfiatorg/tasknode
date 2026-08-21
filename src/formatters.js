export function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCreditUsd(value) {
  const numeric = Number(value || 0);
  const digits = Math.abs(numeric) < 10 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(numeric);
}

export function formatUsageUsd(value) {
  const numeric = Number(value || 0);
  if (numeric > 0 && numeric < 0.01) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 6,
      maximumFractionDigits: 6,
    }).format(numeric);
  }
  return formatUsd(numeric);
}
