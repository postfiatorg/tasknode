export function precisePercentages(values) {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total <= 0n) return values.map(() => '0%');
  const units = values.map(value => Number(BigInt(value) * 100000n / total));
  const order = values.map((value, i) => ({ i, remainder: BigInt(value) * 100000n % total })).sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.i - b.i);
  for (let i = 0, left = 100000 - units.reduce((sum, n) => sum + n, 0); i < left; i++) units[order[i].i]++;
  return units.map((n, i) => n === 0 && BigInt(values[i]) > 0n ? '<0.001%' : `${(n / 1000).toFixed(3).replace(/\.?0+$/, '')}%`);
}
