"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { smokeOptions, createEvidenceDirectory, writeSmokeEvidence } = require("./smoke-evidence.cjs");

test("smoke evidence uses CLI before environment and separates development/packaged runs", () => {
  assert.deepEqual(smokeOptions([], {}), { executable: null, evidenceRoot: resolve(tmpdir()), label: "development" });
  const executable = resolve("packaged-app");
  assert.equal(smokeOptions(["--executable", executable], {}).label, "packaged");
  assert.equal(smokeOptions([], { EMOTION_RUNNER_SMOKE_EVIDENCE_DIR: "ci-evidence" }).evidenceRoot, resolve("ci-evidence"));
  assert.deepEqual(smokeOptions(["--evidence-dir", "cli-evidence", "--evidence-label", "ci-mac"], {
    EMOTION_RUNNER_SMOKE_EVIDENCE_DIR: "ci-evidence",
  }), { executable: null, evidenceRoot: resolve("cli-evidence"), label: "ci-mac" });
  for (const args of [["--executable"], ["--executable", "relative"], ["--evidence-dir", "--executable"], ["--evidence-label", "../outside"]]) {
    assert.throws(() => smokeOptions(args, {}));
  }
});

test("repeated runs keep separate complete failure/success evidence and copied logs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "emotion-runner-evidence-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const options = smokeOptions(["--evidence-dir", join(root, "ci")], {});
  const first = await createEvidenceDirectory(options);
  const second = await createEvidenceDirectory(options);
  assert.notEqual(first, second);
  const userData = join(first, "user-data");
  await mkdir(userData);
  await writeFile(join(userData, "desktop.log"), "started synthetic=true\n");
  const failed = { result: "failed", error: "intentional fixture failure", stdout: ["hello\n"], stderr: ["diagnostic\n"] };
  await writeSmokeEvidence(first, failed, userData);
  await writeSmokeEvidence(second, { result: "passed", stdout: [], stderr: [] }, join(second, "missing-user-data"));
  assert.deepEqual(JSON.parse(await readFile(join(first, "result.json"), "utf8")), failed);
  assert.equal(await readFile(join(first, "electron.stderr.log"), "utf8"), "diagnostic\n");
  assert.equal(await readFile(join(first, "electron.stdout.log"), "utf8"), "hello\n");
  assert.equal(await readFile(join(first, "desktop.log"), "utf8"), "started synthetic=true\n");
  assert.equal(JSON.parse(await readFile(join(second, "result.json"), "utf8")).result, "passed");
});

test("a diagnostic log error still writes a failed result before reporting the error", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "emotion-runner-evidence-error-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "user-data");
  await mkdir(join(userData, "desktop.log"), { recursive: true });
  await assert.rejects(writeSmokeEvidence(root, { result: "passed", stdout: [], stderr: [] }, userData));
  const result = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
  assert.equal(result.result, "failed");
  assert.match(result.evidenceError, /EISDIR/);
});
