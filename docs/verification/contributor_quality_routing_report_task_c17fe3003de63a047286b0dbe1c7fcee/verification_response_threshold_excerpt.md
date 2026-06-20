Verification response for `task_c17fe3003de63a047286b0dbe1c7fcee`.

Source: `scripts/orc-contributor-quality-routing-report.mjs`

The configurable threshold defaults are defined in `buildThresholds`:

```js
function buildThresholds(options) {
  return {
    minTotalForRatio: numberOption(options, "min-total-for-ratio", 3, { min: 1 }),
    minVerifiedRatio: numberOption(options, "min-verified-ratio", 0.3, { min: 0, max: 1 }),
    maxUnverifiable: numberOption(options, "max-unverifiable", 2, { min: 0 }),
    maxRefusals: numberOption(options, "max-refusals", 1, { min: 0 }),
    refusalWindowDays: numberOption(options, "refusal-window-days", 7, { min: 1 }),
    maxConsecutiveUnverifiable: numberOption(options, "max-consecutive-unverifiable", 2, { min: 0 }),
  };
}
```

The rule checks that use those thresholds are:

```js
const verifiedRatio = total ? Number((counts.verified / total).toFixed(4)) : 0;
const refusalCountWindow = refusalWindowCount(sortedRecords, thresholds.refusalWindowDays, generatedAt);
const consecutiveUnverifiable = maxConsecutive(sortedRecords, "unverifiable");

if (consecutiveUnverifiable > thresholds.maxConsecutiveUnverifiable) {
  violations.push({
    rule: "consecutive_unverifiable_submissions",
    observed: consecutiveUnverifiable,
    threshold: thresholds.maxConsecutiveUnverifiable,
    taskIds: sortedRecords.filter((record) => record.outcome === "unverifiable").map((record) => record.taskId),
  });
}
if (refusalCountWindow > thresholds.maxRefusals) {
  violations.push({
    rule: "recent_refusals",
    observed: refusalCountWindow,
    threshold: thresholds.maxRefusals,
    windowDays: thresholds.refusalWindowDays,
    taskIds: sortedRecords.filter((record) => record.outcome === "refused").map((record) => record.taskId),
  });
}
if (total >= thresholds.minTotalForRatio && verifiedRatio < thresholds.minVerifiedRatio) {
  violations.push({
    rule: "low_verified_to_total_ratio",
    observed: verifiedRatio,
    threshold: thresholds.minVerifiedRatio,
    taskIds: sortedRecords.map((record) => record.taskId),
  });
}
```

These rules only emit `routing_review_recommended` entries in a recommend-only report; the script does not mutate live routing state.
