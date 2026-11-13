// Pure price maths for the simple buy/sell ticket. All values are BigInt atoms (6 decimals).
// A level is { size: B23 atoms, total: PFUSDC atoms } taken from the order book, best price first.
const UNIT = 1000000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;

// Where the ticket's price comes from: resting offers on the other side, else the user's own price, else NAV.
export function priceSource(levels, customPrice, nav) {
  if (customPrice && customPrice > 0n) return { kind: "custom", price: customPrice };
  if (levels.length) return { kind: "book", price: (levels[0].total * UNIT) / levels[0].size };
  if (nav && nav > 0n) return { kind: "nav", price: nav };
  return { kind: "none", price: null };
}

// PFUSDC for a B23 quantity. Against the book the limit is the worst level touched, so the whole
// quantity can fill; `filled` is how much of it resting offers cover right now.
export function totalForQuantity(quantity, levels, source) {
  if (!quantity || quantity <= 0n || source.price === null) return null;
  if (source.kind !== "book") return { total: ceilDiv(quantity * source.price, UNIT), filled: 0n, depth: 0n };
  let left = quantity, depth = 0n, worst = levels[0];
  for (const level of levels) { depth += level.size; if (left > 0n) { worst = level; left -= left < level.size ? left : level.size; } }
  return { total: ceilDiv(quantity * worst.total, worst.size), filled: quantity - left, depth };
}

// B23 quantity for a PFUSDC amount (the inverse; rounds the quantity down so the amount is never exceeded).
export function quantityForTotal(total, levels, source) {
  if (!total || total <= 0n || source.price === null) return null;
  if (source.kind !== "book") return (total * UNIT) / source.price;
  let left = total, quantity = 0n;
  for (const level of levels) {
    if (left <= 0n) break;
    const spend = left < level.total ? left : level.total;
    quantity += (spend * level.size) / level.total; left -= spend;
  }
  if (left > 0n) { const last = levels[levels.length - 1]; quantity += (left * last.size) / last.total; }
  return quantity;
}

// "At NAV", "0.50% above NAV", "0.25% below NAV".
export function versusNav(price, nav) {
  if (price === null || !nav || nav <= 0n) return null;
  if (price === nav) return { tone: "success", label: "At NAV" };
  const above = price > nav, bps = ((above ? price - nav : nav - price) * 10000n) / nav;
  const pct = `${bps / 100n}.${String(bps % 100n).padStart(2, "0")}%`;
  return { tone: above ? "warning" : "success", label: `${pct} ${above ? "above" : "below"} NAV` };
}
