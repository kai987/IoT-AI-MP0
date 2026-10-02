"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  APP_URL, isTrustedUrl, allowPermissionCheck, allowPermissionRequest, CONTENT_SECURITY_POLICY,
} = require("../src/policy.cjs");
const { assetPathname, parseRange, createAssetHandler } = require("../src/assets.cjs");

test("trusted origin checks the complete custom protocol authority", () => {
  for (const url of [APP_URL, `${APP_URL}assets/game.js`, "emotion-runner://app"]) assert.equal(isTrustedUrl(url), true);
  for (const url of ["https://app/", "emotion-runner://app.evil/", "emotion-runner://user@app/", "emotion-runner://app:123/", "file:///index.html", "null", ""]) {
    assert.equal(isTrustedUrl(url), false, url);
  }
});

test("only main-frame video permission is granted", () => {
  const details = { isMainFrame: true, securityOrigin: APP_URL, requestingUrl: APP_URL, mediaType: "video", mediaTypes: ["video"] };
  assert.equal(allowPermissionCheck(APP_URL, "media", APP_URL, details), true);
  assert.equal(allowPermissionRequest(APP_URL, "media", details), true);
  for (const permission of ["notifications", "geolocation", "display-capture", "openExternal", "fileSystem", "automatic-fullscreen", "unknown"]) {
    assert.equal(allowPermissionCheck(APP_URL, permission, APP_URL, details), false);
    assert.equal(allowPermissionRequest(APP_URL, permission, details), false);
  }
  for (const change of [
    { isMainFrame: false }, { securityOrigin: "https://attacker.test" },
    { requestingUrl: "https://attacker.test" }, { embeddingOrigin: "https://attacker.test" },
    { mediaType: "audio", mediaTypes: ["audio"] }, { mediaType: "unknown", mediaTypes: [] },
    { mediaType: undefined, mediaTypes: undefined }, { mediaType: "audio", mediaTypes: ["video", "audio"] },
  ]) {
    assert.equal(allowPermissionCheck(APP_URL, "media", APP_URL, { ...details, ...change }), false);
    assert.equal(allowPermissionRequest(APP_URL, "media", { ...details, ...change }), false);
  }
  assert.equal(allowPermissionRequest("https://attacker.test", "media", details), false);
  assert.equal(allowPermissionCheck(APP_URL, "media", "https://attacker.test", details), false);
});

test("fullscreen is allowed only for the trusted main frame", () => {
  const details = { isMainFrame: true, requestingUrl: APP_URL };
  assert.equal(allowPermissionCheck(APP_URL, "fullscreen", APP_URL, details), true);
  assert.equal(allowPermissionRequest(APP_URL, "fullscreen", details), true);
  for (const change of [{ isMainFrame: false }, { requestingUrl: "https://attacker.test" }, { securityOrigin: "https://attacker.test" }]) {
    assert.equal(allowPermissionCheck(APP_URL, "fullscreen", APP_URL, { ...details, ...change }), false);
    assert.equal(allowPermissionRequest(APP_URL, "fullscreen", { ...details, ...change }), false);
  }
});

test("CSP admits local WASM but not remote code, JavaScript eval, or frames", () => {
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /'unsafe-eval'|https:|http:|\*/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src 'none'/);
});

test("asset path mapping admits built assets only", () => {
  assert.equal(assetPathname(APP_URL), "/index.html");
  assert.equal(assetPathname(`${APP_URL}generated/models/model.onnx?v=1`), "/generated/models/model.onnx");
  for (const suffix of ["src/main.cjs", "../package.json", "%2e%2e%2fpackage.json", "assets/%5c..%5csecret.js", "assets/%00.js", "assets/%ZZ.js", "generated/manifest.txt", "assets"])
    assert.equal(assetPathname(`${APP_URL}${suffix}`), null, suffix);
  assert.equal(assetPathname("emotion-runner://elsewhere/assets/game.js"), null);
});

test("range parsing handles ordinary, suffix, open and invalid byte ranges", () => {
  assert.equal(parseRange(null, 10), null);
  assert.deepEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=3-99", 10), { start: 3, end: 9 });
  for (const value of ["bytes=-0", "bytes=10-", "bytes=4-2", "bytes=-", "bytes=0-2,4-6", "bytes=999999999999999999999-", "words=0-2"])
    assert.equal(parseRange(value, 10), false, value);
  assert.equal(parseRange("bytes=0-", 0), false);
});

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "emotion-runner-assets-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const web = path.join(root, "web");
  await fs.mkdir(path.join(web, "assets"), { recursive: true });
  await fs.writeFile(path.join(web, "index.html"), "<!doctype html><h1>Emotion Runner</h1>");
  await fs.writeFile(path.join(web, "assets", "test.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await fs.writeFile(path.join(web, "assets", "empty.js"), "");
  return { root, web, handler: createAssetHandler(web) };
}

test("asset handler streams local content with WASM MIME and security headers", async (context) => {
  const { handler } = await fixture(context);
  const index = await handler(new Request(APP_URL));
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Emotion Runner/);
  assert.equal(index.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.equal(index.headers.get("cross-origin-embedder-policy"), "require-corp");
  const wasm = await handler(new Request(`${APP_URL}assets/test.wasm`));
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  assert.equal((await wasm.arrayBuffer()).byteLength, 8);
});

test("HEAD and partial responses never read or return unnecessary model bytes", async (context) => {
  const { handler } = await fixture(context);
  const head = await handler(new Request(`${APP_URL}assets/test.wasm`, { method: "HEAD" }));
  assert.equal(head.headers.get("content-length"), "8");
  assert.equal(await head.text(), "");
  const part = await handler(new Request(`${APP_URL}assets/test.wasm`, { headers: { Range: "bytes=1-3" } }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 1-3/8");
  assert.equal(await part.text(), "asm");
  const invalid = await handler(new Request(`${APP_URL}assets/test.wasm`, { headers: { Range: "bytes=10-" } }));
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */8");
  const empty = await handler(new Request(`${APP_URL}assets/empty.js`));
  assert.equal(await empty.text(), "");
});

test("protocol rejects unknown files, writes, hostile initiators, and symlink escapes", async (context) => {
  const { root, web, handler } = await fixture(context);
  await fs.writeFile(path.join(root, "secret.js"), "SECRET");
  await fs.symlink(path.join(root, "secret.js"), path.join(web, "assets", "secret.js"));
  for (const suffix of ["assets/missing.js", "assets/secret.js", "package.json"])
    assert.equal((await handler(new Request(`${APP_URL}${suffix}`))).status, 404);
  assert.equal((await handler(new Request(APP_URL, { method: "POST" }))).status, 405);
  const request = new Request(APP_URL);
  Object.defineProperty(request, "initiatorOrigin", { value: "https://attacker.test" });
  assert.equal((await handler(request)).status, 403);
});
