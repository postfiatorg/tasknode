function fitReferencePrefix(packet, target, key, max, minimum = 0) {
  const original = target[key];
  let low = Math.min(minimum, original.length);
  let high = original.length;
  target[key] = original.slice(0, low);
  if (JSON.stringify(packet).length > max) return;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    target[key] = original.slice(0, middle);
    if (JSON.stringify(packet).length <= max) low = middle;
    else high = middle - 1;
  }
  target[key] = original.slice(0, low);
}

export function serializeDocsPacket(packet, max) {
  let serialized = JSON.stringify(packet);
  if (serialized.length <= max) return serialized;

  // Prefer active document/chat over optional personal reference material.
  // Measure serialized strings so quotes and control characters count too.
  for (const [target, key, minimum] of [
    [packet.taskNode, "recentTasks", 0],
    [packet.taskNode, "memory", 0],
    [packet.taskNode, "contextDocument", 0],
    [packet.document, "content", 1024],
  ]) {
    if (target[key] && target[key] !== "null") fitReferencePrefix(packet, target, key, max, minimum);
    serialized = JSON.stringify(packet);
    if (serialized.length <= max) return serialized;
  }

  // Highly escaped chat can exceed the budget even without other references.
  // Keep the whole canonical window, with a common prefix limit per message.
  // Producer bounds on request/metadata leave room for the document excerpt.
  const texts = packet.recentDocumentChat.map(message => message.text);
  let low = 0;
  let high = 2000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    packet.recentDocumentChat.forEach((message, index) => { message.text = texts[index].slice(0, middle); });
    if (JSON.stringify(packet).length <= max) low = middle;
    else high = middle - 1;
  }
  packet.recentDocumentChat.forEach((message, index) => { message.text = texts[index].slice(0, low); });
  return JSON.stringify(packet);
}
