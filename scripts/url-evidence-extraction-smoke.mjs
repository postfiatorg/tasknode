#!/usr/bin/env node
import assert from "node:assert/strict";

import { fetchUrlExcerpt } from "../server/task-review-worker.js";

function response(body = "", { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

function redirect(location, status = 302) {
  return response("", { status, headers: { location } });
}

function mockedFetch(routes, calls = []) {
  return async (url) => {
    calls.push(String(url));
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return typeof route === "function" ? route(url) : route;
  };
}

async function publicLookup(hostname) {
  if (hostname === "gist.githubusercontent.com" || hostname === "api.github.com") {
    return [{ address: "140.82.112.133", family: 4 }];
  }
  return [{ address: "93.184.216.34", family: 4 }];
}

{
  const calls = [];
  const fetchImpl = mockedFetch({
    "https://93.184.216.34/start": redirect("/middle", 302),
    "https://93.184.216.34/middle": redirect("https://93.184.216.35/final", 301),
    "https://93.184.216.35/final": response("<title>Final</title><main>Redirected content body.</main>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  }, calls);

  const result = await fetchUrlExcerpt("https://93.184.216.34/start", { fetchImpl, lookupFn: publicLookup });

  assert.equal(result.status, "extracted");
  assert.equal(result.url, "https://93.184.216.35/final");
  assert.equal(result.title, "Final");
  assert.match(result.excerpt, /Redirected content body/);
  assert.deepEqual(calls, [
    "https://93.184.216.34/start",
    "https://93.184.216.34/middle",
    "https://93.184.216.35/final",
  ]);
}

{
  const calls = [];
  const fetchImpl = mockedFetch({
    "https://93.184.216.34/start": redirect("http://127.0.0.1/private", 302),
  }, calls);

  const result = await fetchUrlExcerpt("https://93.184.216.34/start", { fetchImpl, lookupFn: publicLookup });

  assert.equal(result.status, "blocked");
  assert.equal(result.error, "private_ip_not_allowed");
  assert.equal(result.url, "http://127.0.0.1/private");
  assert.deepEqual(calls, ["https://93.184.216.34/start"]);
}

{
  const calls = [];
  const fetchImpl = mockedFetch({
    "https://gist.githubusercontent.com/alice/abc123/raw": response("Navcoin series evidence\nImplementation notes", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  }, calls);

  const result = await fetchUrlExcerpt("https://gist.github.com/alice/abc123#file-notes-md", {
    fetchImpl,
    lookupFn: publicLookup,
  });

  assert.equal(result.status, "extracted");
  assert.equal(result.url, "https://gist.githubusercontent.com/alice/abc123/raw");
  assert.equal(result.source_url, "https://gist.github.com/alice/abc123#file-notes-md");
  assert.match(result.excerpt, /Navcoin series evidence/);
  assert.deepEqual(calls, ["https://gist.githubusercontent.com/alice/abc123/raw"]);
}

{
  const calls = [];
  const fetchImpl = mockedFetch({}, calls);
  const result = await fetchUrlExcerpt("https://gist.github.com/alice/abc123", {
    fetchImpl,
    lookupFn: async (hostname) => {
      if (hostname === "gist.githubusercontent.com") return [{ address: "127.0.0.1", family: 4 }];
      return publicLookup(hostname);
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.error, "dns_private_ip_not_allowed");
  assert.deepEqual(calls, [], "gist raw host safety must run before fetch");
}

{
  const html = `
    <!doctype html>
    <html>
      <head>
        <title>Clean &amp; Separate Title</title>
        <style>.hidden { display:none }</style>
        <script>window.secret = "bad";</script>
      </head>
      <body>
        <nav>Navigation should disappear</nav>
        <header>Header should disappear</header>
        <main>
          <h1>Article body</h1>
          <p>The navcoin series &amp; research context &#39;matters&#39; &lt;here&gt;.</p>
        </main>
        <footer>Footer should disappear</footer>
      </body>
    </html>
  `;
  const fetchImpl = mockedFetch({
    "https://93.184.216.34/article": response(html, {
      headers: { "content-type": "text/html" },
    }),
  });

  const result = await fetchUrlExcerpt("https://93.184.216.34/article", { fetchImpl, lookupFn: publicLookup });

  assert.equal(result.status, "extracted");
  assert.equal(result.title, "Clean & Separate Title");
  assert.match(result.excerpt, /Article body/);
  assert.match(result.excerpt, /navcoin series & research context 'matters' <here>/);
  assert.ok(!result.excerpt.includes("window.secret"));
  assert.ok(!result.excerpt.includes("Navigation should disappear"));
  assert.ok(!result.excerpt.includes("Clean & Separate Title"), "title should be separate from excerpt");
}

{
  const routes = {};
  for (let index = 0; index <= 5; index += 1) {
    routes[`https://93.184.216.34/hop-${index}`] = redirect(`/hop-${index + 1}`, 302);
  }
  const calls = [];
  const result = await fetchUrlExcerpt("https://93.184.216.34/hop-0", {
    fetchImpl: mockedFetch(routes, calls),
    lookupFn: publicLookup,
  });

  assert.equal(result.status, "too_many_redirects");
  assert.equal(calls.length, 6);
}

console.log("url evidence extraction smoke ok");
