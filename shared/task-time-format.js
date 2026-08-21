export function taskIso(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function parsedDate(value) {
  const iso = taskIso(value);
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sameYear(date) {
  return date.getFullYear() === new Date().getFullYear();
}

function dateOptions(date, { timeZone } = {}) {
  return {
    month: "short",
    day: "numeric",
    ...(sameYear(date) ? {} : { year: "numeric" }),
    ...(timeZone ? { timeZone } : {}),
  };
}

function dateTimeOptions(date, { timeZone } = {}) {
  return {
    ...dateOptions(date, { timeZone }),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
}

function isDateOnlyText(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function isUtcMidnight(date) {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

export function taskDeadlineHasExplicitTime(value) {
  const date = parsedDate(value);
  if (!date) return false;
  return !isDateOnlyText(value) && !isUtcMidnight(date);
}

export function formatTaskDeadline(value, options = {}) {
  const date = parsedDate(value);
  if (!date) return "No deadline";
  const formatterOptions = taskDeadlineHasExplicitTime(value)
    ? dateTimeOptions(date, options)
    : dateOptions(date, { timeZone: options.timeZone || "UTC" });
  return new Intl.DateTimeFormat(options.locale, formatterOptions).format(date);
}

export function formatTaskTimestamp(value, options = {}) {
  const date = parsedDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(options.locale, dateTimeOptions(date, options)).format(date);
}
