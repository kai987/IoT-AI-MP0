import { log } from "node:console";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptsDirectory, "..");
const modelRoot = resolve(webRoot, "..", "models");
const manifestPath = join(webRoot, "model-manifest.json");
const generatedRoot = join(webRoot, "public", "generated");
const generatedModelRoot = join(generatedRoot, "models");
const assetManifestPath = join(generatedRoot, "ort", "asset-manifest.json");

const expectedFiles = new Set([
  "enet_b0_8_best_vgaf.onnx",
  "face_landmarker.task",
  "LICENSE-EMOTIEFFLIB.txt",
  "LICENSE-MEDIAPIPE.txt",
  "MODEL_SOURCES.md",
]);
const legacyFiles = new Set([
  "emotion-ferplus-8.onnx",
  "face_detection_yunet_2023mar.onnx",
  "opencv_face_detector_fp16.caffemodel",
  "opencv_face_detector_fp16.prototxt",
]);

function fail(message) {
  throw new Error(`[verify-models] ${message}`);
}

function assertInside(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    fail(`${label} escapes its allowed directory`);
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
}

async function sha256(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function walk(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walk(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}

async function main() {
  const manifest = await readJson(manifestPath, "model-manifest.json");
  const assetManifest = await readJson(
    assetManifestPath,
    "generated/ort/asset-manifest.json; run npm run prepare:assets first",
  );
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    fail("invalid model manifest schema");
  }
  if (assetManifest.schemaVersion !== 1 || !Array.isArray(assetManifest.files)) {
    fail("invalid generated asset manifest schema");
  }

  const manifestNames = new Set(manifest.files.map((entry) => entry.filename));
  if (
    manifest.files.length !== expectedFiles.size ||
    manifestNames.size !== expectedFiles.size ||
    [...expectedFiles].some((name) => !manifestNames.has(name))
  ) {
    fail(`manifest must contain exactly: ${[...expectedFiles].join(", ")}`);
  }

  const generatedNames = new Set(
    (await readdir(generatedModelRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  if (
    generatedNames.size !== expectedFiles.size ||
    [...expectedFiles].some((name) => !generatedNames.has(name))
  ) {
    fail(`generated model directory must contain exactly: ${[...expectedFiles].join(", ")}`);
  }

  const generatedEntries = new Map(
    assetManifest.files.map((entry) => [entry.path, entry]),
  );
  for (const entry of manifest.files) {
    if (!expectedFiles.has(entry.filename) || basename(entry.source) !== entry.filename) {
      fail(`unapproved model manifest entry: ${entry.filename}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      fail(`invalid SHA-256 for ${entry.filename}`);
    }

    const source = resolve(webRoot, entry.source);
    const target = resolve(webRoot, entry.target);
    assertInside(modelRoot, source, `source for ${entry.filename}`);
    assertInside(generatedModelRoot, target, `target for ${entry.filename}`);
    if (basename(target) !== entry.filename) {
      fail(`generated target name does not match ${entry.filename}`);
    }
    const sourceHash = await sha256(source);
    const targetHash = await sha256(target);
    if (sourceHash !== entry.sha256 || targetHash !== entry.sha256) {
      fail(
        `${entry.filename} hash mismatch: manifest=${entry.sha256} ` +
          `source=${sourceHash} generated=${targetHash}`,
      );
    }
    const generatedEntry = generatedEntries.get(`models/${entry.filename}`);
    if (!generatedEntry || generatedEntry.sha256 !== entry.sha256) {
      fail(`${entry.filename} is missing or incorrect in asset-manifest.json`);
    }
    const info = await stat(target);
    if (generatedEntry.bytes !== info.size) {
      fail(`${entry.filename} byte size does not match asset-manifest.json`);
    }
  }

  for (const path of await walk(generatedRoot)) {
    if (legacyFiles.has(basename(path))) {
      fail(`legacy or desktop-only model leaked into web assets: ${basename(path)}`);
    }
  }

  log(
    `[verify-models] verified ${expectedFiles.size} model/license files and their SHA-256 hashes`,
  );
}

await main();
