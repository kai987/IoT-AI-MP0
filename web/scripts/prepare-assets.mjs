import { log } from "node:console";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { gzip } from "node:zlib";

const require = createRequire(import.meta.url);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptsDirectory, "..");
const repositoryRoot = resolve(webRoot, "..");
const modelRoot = join(repositoryRoot, "models");
const manifestPath = join(webRoot, "model-manifest.json");
const generatedRoot = join(webRoot, "public", "generated");
const gzipAsync = promisify(gzip);
const sitesFileSizeLimit = 25 * 1024 * 1024;

const expectedModelFiles = new Set([
  "enet_b0_8_best_vgaf.onnx",
  "face_landmarker.task",
  "LICENSE-EMOTIEFFLIB.txt",
  "LICENSE-MEDIAPIPE.txt",
  "MODEL_SOURCES.md",
]);

function fail(message) {
  throw new Error(`[prepare-assets] ${message}`);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function assertInside(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    fail(`${label} escapes its allowed directory: ${candidate}`);
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

async function resolvePackage(packageName) {
  let entryPath;
  try {
    entryPath = require.resolve(`${packageName}/package.json`);
  } catch {
    try {
      entryPath = require.resolve(packageName);
    } catch (error) {
      fail(`cannot resolve ${packageName}: ${error.message}`);
    }
  }

  let current = dirname(entryPath);
  while (true) {
    const packageJsonPath = join(current, "package.json");
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (packageJson.name === packageName) {
        return { root: current, packageJson };
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        fail(`cannot inspect ${packageJsonPath}: ${error.message}`);
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      fail(`package root not found for ${packageName}`);
    }
    current = parent;
  }
}

function selectImportTarget(exportValue) {
  if (typeof exportValue === "string") {
    return exportValue;
  }
  if (!exportValue || typeof exportValue !== "object") {
    return null;
  }
  return (
    selectImportTarget(exportValue.default) ??
    selectImportTarget(exportValue.import) ??
    Object.values(exportValue)
      .map(selectImportTarget)
      .find((value) => value !== null) ??
    null
  );
}

async function copyVerified({ source, target, expectedHash, sourceLabel }) {
  const sourceInfo = await stat(source).catch((error) => {
    fail(`missing ${sourceLabel}: ${error.message}`);
  });
  if (!sourceInfo.isFile()) {
    fail(`${sourceLabel} is not a regular file`);
  }

  const sourceHash = await sha256(source);
  if (expectedHash && sourceHash !== expectedHash) {
    fail(
      `${sourceLabel} SHA-256 mismatch: expected ${expectedHash}, got ${sourceHash}`,
    );
  }

  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);

  const targetInfo = await stat(target);
  const targetHash = await sha256(target);
  if (targetHash !== sourceHash || targetInfo.size !== sourceInfo.size) {
    fail(`${sourceLabel} changed while being copied`);
  }

  return {
    path: toPosix(relative(generatedRoot, target)),
    sha256: targetHash,
    bytes: targetInfo.size,
    source: sourceLabel,
  };
}

async function copyRuntimeFile({ source, filename, sourceLabel }) {
  const sourceInfo = await stat(source).catch((error) => {
    fail(`missing ${sourceLabel}: ${error.message}`);
  });
  if (!sourceInfo.isFile()) {
    fail(`${sourceLabel} is not a regular file`);
  }

  if (sourceInfo.size <= sitesFileSizeLimit) {
    return copyVerified({
      source,
      target: join(generatedRoot, "ort", filename),
      sourceLabel,
    });
  }
  if (!filename.endsWith(".wasm")) {
    fail(`${sourceLabel} exceeds the Sites single-file size limit`);
  }

  const target = join(generatedRoot, "ort", `${filename}.gzip`);
  const compressed = await gzipAsync(await readFile(source), { level: 9 });
  if (compressed.byteLength > sitesFileSizeLimit) {
    fail(`${sourceLabel} remains too large after gzip compression`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, compressed);
  return {
    path: toPosix(relative(generatedRoot, target)),
    sha256: await sha256(target),
    bytes: compressed.byteLength,
    source: `${sourceLabel} (gzip-compressed from ${sourceInfo.size} bytes)`,
  };
}

function validateModelManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    fail("model-manifest.json must use schemaVersion 1 with a files array");
  }

  const filenames = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object") {
      fail("model manifest contains a non-object entry");
    }
    if (!expectedModelFiles.has(entry.filename)) {
      fail(`model manifest contains an unapproved file: ${entry.filename}`);
    }
    if (filenames.has(entry.filename)) {
      fail(`model manifest contains a duplicate file: ${entry.filename}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      fail(`invalid SHA-256 for ${entry.filename}`);
    }
    filenames.add(entry.filename);
  }

  const missing = [...expectedModelFiles].filter((name) => !filenames.has(name));
  if (missing.length > 0 || filenames.size !== expectedModelFiles.size) {
    fail(`model manifest must contain exactly: ${[...expectedModelFiles].join(", ")}`);
  }
}

async function prepareModels(manifest) {
  const copied = [];
  for (const entry of manifest.files) {
    const source = resolve(webRoot, entry.source);
    const target = resolve(webRoot, entry.target);
    assertInside(modelRoot, source, `source for ${entry.filename}`);
    assertInside(
      join(generatedRoot, "models"),
      target,
      `target for ${entry.filename}`,
    );
    if (basename(source) !== entry.filename || basename(target) !== entry.filename) {
      fail(`source and target names must match ${entry.filename}`);
    }
    copied.push(
      await copyVerified({
        source,
        target,
        expectedHash: entry.sha256,
        sourceLabel: `models/${entry.filename}`,
      }),
    );
  }
  return copied;
}

async function prepareMediaPipeRuntime() {
  const mediaPipe = await resolvePackage("@mediapipe/tasks-vision");
  const wasmDirectory = join(mediaPipe.root, "wasm");
  const filenames = (await readdir(wasmDirectory))
    .filter((name) => /^vision_wasm[\w.-]*\.(?:js|wasm)$/.test(name))
    .sort();

  if (filenames.length === 0) {
    fail("@mediapipe/tasks-vision contains no distributable WASM runtime");
  }
  const mediaPipeStems = new Map();
  for (const filename of filenames) {
    const stem = filename.replace(/\.(?:js|wasm)$/, "");
    const extensions = mediaPipeStems.get(stem) ?? new Set();
    extensions.add(filename.endsWith(".wasm") ? ".wasm" : ".js");
    mediaPipeStems.set(stem, extensions);
  }
  for (const [stem, extensions] of mediaPipeStems) {
    if (!extensions.has(".js") || !extensions.has(".wasm")) {
      fail(`incomplete MediaPipe runtime pair: ${stem}`);
    }
  }

  const copied = [];
  for (const filename of filenames) {
    copied.push(
      await copyVerified({
        source: join(wasmDirectory, filename),
        target: join(generatedRoot, "mediapipe", filename),
        sourceLabel: `@mediapipe/tasks-vision/wasm/${filename}`,
      }),
    );
  }
  return {
    package: "@mediapipe/tasks-vision",
    version: mediaPipe.packageJson.version,
    files: copied,
  };
}

async function prepareOrtRuntime() {
  const ort = await resolvePackage("onnxruntime-web");
  const exportsMap = ort.packageJson.exports;
  const bundleTargets = [
    selectImportTarget(exportsMap?.["."]?.import ?? exportsMap?.["."]),
    selectImportTarget(exportsMap?.["./webgpu"]?.import ?? exportsMap?.["./webgpu"]),
  ];
  if (bundleTargets.some((target) => typeof target !== "string")) {
    fail("onnxruntime-web does not expose both WASM and WebGPU import bundles");
  }

  const runtimeFilenames = new Set();
  for (const bundleTarget of bundleTargets) {
    const bundlePath = resolve(ort.root, bundleTarget);
    assertInside(ort.root, bundlePath, `onnxruntime-web bundle ${bundleTarget}`);
    const bundle = await readFile(bundlePath, "utf8");
    const bundleRuntimeFiles = new Set(
      [...bundle.matchAll(/ort-wasm-[A-Za-z0-9._-]+\.(?:mjs|wasm)/g)].map(
        (match) => match[0],
      ),
    );
    if (
      ![...bundleRuntimeFiles].some((name) => name.endsWith(".mjs")) ||
      ![...bundleRuntimeFiles].some((name) => name.endsWith(".wasm"))
    ) {
      fail(`incomplete ONNX Runtime files referenced by ${bundleTarget}`);
    }
    for (const filename of bundleRuntimeFiles) {
      runtimeFilenames.add(filename);
    }
  }

  if (runtimeFilenames.size === 0) {
    fail("cannot determine the ONNX Runtime WebGPU/WASM runtime files");
  }

  const copied = [];
  for (const filename of [...runtimeFilenames].sort()) {
    let source;
    try {
      source = require.resolve(`onnxruntime-web/${filename}`);
    } catch {
      source = join(ort.root, "dist", filename);
    }
    assertInside(ort.root, source, `onnxruntime-web runtime ${filename}`);
    copied.push(
      await copyRuntimeFile({
        source,
        filename,
        sourceLabel: `onnxruntime-web/dist/${filename}`,
      }),
    );
  }
  return {
    package: "onnxruntime-web",
    version: ort.packageJson.version,
    files: copied,
  };
}

async function main() {
  const modelManifest = await readJson(manifestPath, "model-manifest.json");
  validateModelManifest(modelManifest);

  // Recreate the directory so removed or legacy models cannot survive a build.
  await rm(generatedRoot, { recursive: true, force: true });
  await mkdir(generatedRoot, { recursive: true });

  const modelFiles = await prepareModels(modelManifest);
  const mediaPipe = await prepareMediaPipeRuntime();
  const onnxRuntime = await prepareOrtRuntime();
  const files = [...modelFiles, ...mediaPipe.files, ...onnxRuntime.files].sort(
    (left, right) => left.path.localeCompare(right.path),
  );

  const assetManifest = {
    schemaVersion: 1,
    packages: {
      mediapipe: {
        name: mediaPipe.package,
        version: mediaPipe.version,
      },
      onnxruntime: {
        name: onnxRuntime.package,
        version: onnxRuntime.version,
      },
    },
    files,
  };
  await writeFile(
    join(generatedRoot, "ort", "asset-manifest.json"),
    `${JSON.stringify(assetManifest, null, 2)}\n`,
    "utf8",
  );

  log(
    `[prepare-assets] copied ${modelFiles.length} model/license files, ` +
      `${mediaPipe.files.length} MediaPipe files, and ` +
      `${onnxRuntime.files.length} ONNX Runtime files`,
  );
}

await main();
