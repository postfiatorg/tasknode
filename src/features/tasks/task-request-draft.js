// Non-extractable browser key + encrypted account-scoped pending command. The
// original IDs survive a lost response, tab close, or browser restart.
const databaseName = "tasknode-task-request-recovery-v1";

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function record(key, value) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("records", value === undefined ? "readonly" : "readwrite");
      const store = transaction.objectStore("records");
      const request = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Request recovery storage was interrupted."));
    });
  } finally { db.close(); }
}

async function recoveryKey() {
  let key = await record("key");
  if (!key) {
    const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const db = await database();
    try {
      key = await new Promise((resolve, reject) => {
        const transaction = db.transaction("records", "readwrite");
        const store = transaction.objectStore("records");
        const request = store.get("key");
        let selected;
        request.onsuccess = () => { selected = request.result || candidate; if (!request.result) store.add(candidate, "key"); };
        transaction.oncomplete = () => resolve(selected);
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }
  return key;
}

export async function readTaskRequestDraft(accountId) {
  if (!accountId) return null;
  const records = await commands(accountId);
  const encrypted = records.sort((a, b) => b.createdAt - a.createdAt)[0] || await record(`draft:${accountId}`);
  if (!encrypted) return null;
  return decrypt(accountId, encrypted);
}

async function decrypt(accountId, encrypted) {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: encrypted.iv, additionalData: new TextEncoder().encode(accountId) }, await recoveryKey(), encrypted.data);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function commands(accountId, update) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("records", update ? "readwrite" : "readonly");
      const store = transaction.objectStore("records");
      const prefix = `command:${accountId}:`;
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      const values = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { values.push(cursor.value); update?.(cursor); cursor.continue(); }
      };
      transaction.oncomplete = () => resolve(values);
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function saveTaskRequestDraft(accountId, draft) {
  if (!accountId) throw new Error("Sign in before saving a request.");
  // Identical uncertain submissions share one command across tabs. Different
  // intentions keep separate encrypted records, so neither tab erases the other.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(draft.userDetailText));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = `command:${accountId}:${fingerprint}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(accountId) }, await recoveryKey(), new TextEncoder().encode(JSON.stringify(draft)));
  const db = await database();
  let selected;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      const request = store.get(id);
      request.onsuccess = () => {
        selected = request.result || { iv, data, requestId: draft.requestId, createdAt: Date.now() };
        if (!request.result) store.add(selected, id);
      };
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
  return decrypt(accountId, selected);
}

export async function clearTaskRequestDraft(accountId, requestId) {
  await commands(accountId, (cursor) => { if (cursor.value.requestId === requestId) cursor.delete(); });
  const legacy = await record(`draft:${accountId}`);
  if (legacy && (await decrypt(accountId, legacy)).requestId === requestId) await record(`draft:${accountId}`, null);
}
