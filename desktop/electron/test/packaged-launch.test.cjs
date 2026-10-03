"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { debuggerEndpoints, inspectorValue, packagedWindowReady, cleanExit } = require("./packaged-launch.cjs");

test("packaged launcher distinguishes Node and browser debugger endpoints across startup logs", () => {
  assert.deepEqual(debuggerEndpoints("Debugger attached."), { node: null, browser: null });
  assert.deepEqual(debuggerEndpoints("Debugger listening on ws://127.0.0.1:123/node-id\nFor help: documentation\nDevTools listening on ws://127.0.0.1:456/devtools/browser/browser-id\n"), {
    node: "ws://127.0.0.1:123/node-id", browser: "ws://127.0.0.1:456/devtools/browser/browser-id",
  });
});

test("packaged inspector preserves primitive and object values including undefined", () => {
  for (const value of [false, 0, "ready", null, { sandbox: true, cameras: [] }]) {
    assert.deepEqual(inspectorValue({ result: { result: { value } } }), value);
  }
  assert.equal(inspectorValue({ result: { result: { type: "undefined" } } }), undefined);
});

test("packaged inspector does not hide protocol or evaluation failures", () => {
  assert.throws(() => inspectorValue({ error: { message: "protocol failure" } }), /protocol failure/);
  assert.throws(() => inspectorValue({ result: { exceptionDetails: { exception: { description: "ReferenceError: missing loader" } } } }), /missing loader/);
  assert.throws(() => inspectorValue({ result: { exceptionDetails: { text: "Uncaught" } } }), /Uncaught/);
});

test("packaged CDP attachment waits for the real trusted window to finish its navigation", () => {
  const window = (url, loading = false, destroyed = false) => ({
    isDestroyed: () => destroyed, webContents: { getURL: () => url, isLoading: () => loading },
  });
  const state = (ready, windows) => ({ app: { isReady: () => ready }, BrowserWindow: { getAllWindows: () => windows } });
  assert.equal(packagedWindowReady(state(false, [window("emotion-runner://app/")])), false);
  assert.equal(packagedWindowReady(state(true, [])), false);
  assert.equal(packagedWindowReady(state(true, [window(""), window("https://attacker.test/"), window("emotion-runner://app/", true)])), false);
  assert.equal(packagedWindowReady(state(true, [window("emotion-runner://app/", false, true)])), false);
  assert.equal(packagedWindowReady(state(true, [window("emotion-runner://app/")])), true);
});

test("packaged close accepts only exit code zero without termination signals", () => {
  assert.deepEqual(cleanExit({ code: 0, signal: null }), { code: 0, signal: null });
  for (const result of [{ code: 1, signal: null }, { code: null, signal: "SIGKILL" }, { code: 0, signal: "SIGTERM" }, { code: null, signal: null }]) {
    assert.throws(() => cleanExit(result), /did not exit cleanly/);
  }
});
