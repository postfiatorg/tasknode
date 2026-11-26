import assert from "node:assert/strict";
import { docsRecoveryPackage, recoverPromptLibrary } from "../src/features/docs-library/prompt-recovery.js";
import { newLibraryKey, encryptPrompt } from "../packages/tasknode-cli/lib/prompt-crypto.mjs";
import {
  generateTaskNodeMnemonic,
  deriveTaskNodePublicKey,
  encryptTaskNodePayload,
  decryptTaskNodePayload,
} from "../src/wallet-core.js";

const mnemonic = generateTaskNodeMnemonic();
const rootKey = newLibraryKey();
const libraryKey = newLibraryKey();
const documentId = crypto.randomUUID();
const eventId = crypto.randomUUID();
const metadata = {
  documentId,
  documentType: "prompt",
  title: "Synthetic recovery prompt",
  editHref: "/code/#synthetic-secret-capability",
};
const encryptedRootKeyEnvelope = await encryptTaskNodePayload({
  plaintext: JSON.stringify({ rootKey }),
  recipientPublicKeys: [await deriveTaskNodePublicKey(mnemonic)],
});
const backup = docsRecoveryPackage({
  account: { encryptedRootKeyEnvelope },
  documents: [
    { documentId, owned: true, documentType: "prompt", encryptedMetadata: await encryptPrompt(metadata, libraryKey) },
  ],
  prompts: {
    keyEnvelope: await encryptPrompt({ key: libraryKey }, rootKey),
    history: [
      {
        eventId,
        documentId,
        ciphertext: await encryptPrompt(
          { eventId, documentId, kind: "version_saved", text: "Synthetic saved version" },
          libraryKey,
        ),
      },
    ],
  },
});
const serialized = JSON.stringify(backup);
for (const secret of [mnemonic, rootKey, libraryKey, metadata.editHref, metadata.title, "Synthetic saved version"]) {
  assert.ok(!serialized.includes(secret));
}
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Original server is unavailable");
};
try {
  const exported = JSON.parse(serialized);
  const recoveredRoot = JSON.parse(
    await decryptTaskNodePayload({ blob: exported.account.encryptedRootKeyEnvelope, mnemonic }),
  );
  const recovered = await recoverPromptLibrary(exported, recoveredRoot.rootKey);
  assert.deepEqual(recovered.documents, [metadata]);
  assert.equal(recovered.events[0].text, "Synthetic saved version");
  await assert.rejects(recoverPromptLibrary(exported, newLibraryKey()));
  exported.documents[0].documentId = crypto.randomUUID();
  await assert.rejects(recoverPromptLibrary(exported, recoveredRoot.rootKey), /identity mismatch/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "PASS encrypted recovery: export plus wallet restores prompt capabilities and saved text offline; no plaintext keys in export; tampered row rejected",
);
