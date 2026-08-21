import assert from "node:assert/strict";

import {
  providerResponseDigest,
  resolveGithubCollaboratorPermission,
  resolveXUserMetrics,
} from "../server/repositories/identity-provider-resolvers.js";

function jsonResponse(body = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const digest = providerResponseDigest({ b: 2, a: 1 });
assert.match(digest, /^sha256:[a-f0-9]{64}$/);
assert.equal(digest, providerResponseDigest({ a: 1, b: 2 }), "digest should be stable for object key order");

let lastRequest = null;
const xResult = await resolveXUserMetrics({
  username: "@goodalexander",
  bearerToken: "x-token",
  fetchImpl: async (url, options = {}) => {
    lastRequest = { url: String(url), headers: options.headers || {} };
    return jsonResponse({
      data: {
        id: "123",
        username: "goodalexander",
        name: "Good Alexander",
        verified: true,
        verified_type: "blue",
        public_metrics: {
          followers_count: 134000,
          following_count: 100,
          listed_count: 20,
          tweet_count: 5000,
        },
      },
    });
  },
});
assert.match(lastRequest.url, /\/2\/users\/by\/username\/goodalexander/);
assert.match(lastRequest.url, /user\.fields=.*public_metrics/);
assert.equal(lastRequest.headers.authorization, "Bearer x-token");
assert.equal(xResult.metrics.followersCount, 134000);
assert.equal(xResult.qualifications.kolXMinimum, true);
assert.equal(xResult.qualifications.kolXFull, true);
assert.equal(xResult.profileUrl, "https://x.com/goodalexander");

await assert.rejects(
  () => resolveXUserMetrics({ username: "goodalexander", fetchImpl: async () => jsonResponse({}) }),
  /x_bearer_token_required/
);

const collabResult = await resolveGithubCollaboratorPermission({
  owner: "postfiatorg",
  repo: "tasknodeofficial",
  username: "goodalexander",
  token: "gh-token",
  fetchImpl: async (url, options = {}) => {
    lastRequest = { url: String(url), headers: options.headers || {} };
    return jsonResponse({
      permission: "write",
      user: { login: "goodalexander" },
    });
  },
});
assert.match(lastRequest.url, /\/repos\/postfiatorg\/tasknodeofficial\/collaborators\/goodalexander\/permission$/);
assert.equal(lastRequest.headers.authorization, "Bearer gh-token");
assert.equal(collabResult.permission, "write");
assert.equal(collabResult.writeAccess, true);
assert.equal(collabResult.proofMethod, "github_collaborator_permission_api");

await assert.rejects(
  () => resolveGithubCollaboratorPermission({
    owner: "postfiatorg",
    repo: "tasknodeofficial",
    username: "goodalexander",
    fetchImpl: async () => jsonResponse({ permission: "write" }),
  }),
  /github_token_required/
);

console.log("identity provider resolvers smoke ok");
