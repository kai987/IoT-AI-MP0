import { log } from "node:console";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptsDirectory, "..");
const repositoryRoot = resolve(webRoot, "..");
const distRoot = join(webRoot, "dist");
const clientRoot = join(distRoot, "client");
const preparedRoot = join(webRoot, "public", "generated");
const preparedManifestPath = join(preparedRoot, "ort", "asset-manifest.json");
const distManifestPath = join(
  clientRoot,
  "generated",
  "ort",
  "asset-manifest.json",
);

const legacyFiles = new Set([
  "emotion-ferplus-8.onnx",
  "face_detection_yunet_2023mar.onnx",
  "opencv_face_detector_fp16.caffemodel",
  "opencv_face_detector_fp16.prototxt",
]);
const expectedModelBinaries = new Set([
  "enet_b0_8_best_vgaf.onnx",
  "face_landmarker.task",
]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);
const forbiddenText = [
  { pattern: /\/Users\//i, label: "a macOS user path" },
  {
    pattern:
      /(?:https?|wss?):\/\/localhost(?=[:/?#]|$)|\/\/localhost(?=[:/?#]|$)|\blocalhost(?=:\d+\b)|\b(?:127\.0\.0\.1|0\.0\.0\.0)\b/i,
    label: "a hard-coded local host URL",
  },
  { pattern: /\/home\/runner\/work\//i, label: "a GitHub runner path" },
  { pattern: /[A-Za-z]:[\\/]Users[\\/]/, label: "a Windows user path" },
  { pattern: /sourceMappingURL\s*=/i, label: "a source-map directive" },
  {
    pattern:
      /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdn\.skypack\.dev|esm\.sh|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|storage\.googleapis\.com)\//i,
    label: "a CDN runtime URL",
  },
];

function fail(message) {
  throw new Error(`[check-production-build] ${message}`);
}

async function sha256(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
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

function validateAssetPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    fail(`unsafe asset path in manifest: ${path}`);
  }
}

async function main() {
  const distInfo = await stat(distRoot).catch((error) => {
    fail(`dist is missing; run npm run build first: ${error.message}`);
  });
  if (!distInfo.isDirectory()) {
    fail("dist is not a directory");
  }
  const indexInfo = await stat(join(clientRoot, "index.html")).catch((error) => {
    fail(`dist/client/index.html is missing: ${error.message}`);
  });
  if (!indexInfo.isFile() || indexInfo.size === 0) {
    fail("dist/client/index.html is empty or invalid");
  }
  const siteWorkerInfo = await stat(join(distRoot, "server", "index.js")).catch(
    (error) => {
      fail(`dist/server/index.js is missing: ${error.message}`);
    },
  );
  if (!siteWorkerInfo.isFile() || siteWorkerInfo.size === 0) {
    fail("dist/server/index.js is empty or invalid");
  }
  const hostingInfo = await stat(
    join(distRoot, ".openai", "hosting.json"),
  ).catch((error) => {
    fail(`dist/.openai/hosting.json is missing: ${error.message}`);
  });
  if (!hostingInfo.isFile() || hostingInfo.size === 0) {
    fail("dist/.openai/hosting.json is empty or invalid");
  }
  const configuredBase = env.VITE_BASE_PATH;
  if (configuredBase) {
    const trimmedBase = configuredBase.replace(/^\/+|\/+$/g, "");
    const normalizedBase = trimmedBase ? `/${trimmedBase}/` : "/";
    const indexHtml = await readFile(join(clientRoot, "index.html"), "utf8");
    if (!indexHtml.includes(normalizedBase)) {
      fail(`dist/client/index.html does not use VITE_BASE_PATH=${normalizedBase}`);
    }
    if (/(?:src|href)="\/(?:assets|generated)\//i.test(indexHtml)) {
      fail("dist/client/index.html contains an asset URL outside VITE_BASE_PATH");
    }
  }

  const preparedManifest = await readJson(
    preparedManifestPath,
    "public/generated/ort/asset-manifest.json",
  );
  const distManifest = await readJson(
    distManifestPath,
    "dist/client/generated/ort/asset-manifest.json",
  );
  if (
    preparedManifest.schemaVersion !== 1 ||
    !Array.isArray(preparedManifest.files) ||
    preparedManifest.files.length === 0
  ) {
    fail("prepared asset manifest is invalid or empty");
  }
  if (JSON.stringify(distManifest) !== JSON.stringify(preparedManifest)) {
    fail("dist asset manifest differs from the prepared asset manifest");
  }

  const seenPaths = new Set();
  for (const entry of preparedManifest.files) {
    validateAssetPath(entry.path);
    if (seenPaths.has(entry.path)) {
      fail(`duplicate asset manifest path: ${entry.path}`);
    }
    seenPaths.add(entry.path);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      fail(`invalid SHA-256 in asset manifest: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail(`invalid byte size in asset manifest: ${entry.path}`);
    }

    for (const [label, root] of [
      ["prepared", preparedRoot],
      ["dist", join(clientRoot, "generated")],
    ]) {
      const path = join(root, ...entry.path.split("/"));
      const info = await stat(path).catch((error) => {
        fail(`${label} asset is missing (${entry.path}): ${error.message}`);
      });
      if (!info.isFile() || info.size !== entry.bytes) {
        fail(`${label} asset size mismatch: ${entry.path}`);
      }
      const digest = await sha256(path);
      if (digest !== entry.sha256) {
        fail(`${label} asset SHA-256 mismatch: ${entry.path}`);
      }
    }
  }

  const distFiles = await walk(distRoot);
  const generatedDistFiles = await walk(join(clientRoot, "generated"));
  const allowedGenerated = new Set([
    "ort/asset-manifest.json",
    ...preparedManifest.files.map((entry) => entry.path),
  ]);
  for (const path of generatedDistFiles) {
    const relativePath = path
      .slice(join(clientRoot, "generated").length + 1)
      .split(sep)
      .join("/");
    if (!allowedGenerated.has(relativePath)) {
      fail(`unexpected generated production asset: ${relativePath}`);
    }
  }

  const localPathFragments = [repositoryRoot, webRoot]
    .map((path) => path.split(sep).join("/"))
    .filter(Boolean);
  const discoveredModelBinaries = [];
  for (const path of distFiles) {
    if (legacyFiles.has(basename(path))) {
      fail(`legacy or desktop-only model exists in dist: ${basename(path)}`);
    }
    if (extname(path).toLowerCase() === ".map") {
      fail(`source map exists in dist: ${path.slice(distRoot.length + 1)}`);
    }
    if ([".onnx", ".task", ".caffemodel", ".prototxt"].includes(extname(path))) {
      const filename = basename(path);
      if (!expectedModelBinaries.has(filename)) {
        fail(`unapproved model binary exists in dist: ${filename}`);
      }
      discoveredModelBinaries.push(filename);
    }
    if (!textExtensions.has(extname(path).toLowerCase())) {
      continue;
    }
    const text = await readFile(path, "utf8");
    for (const { pattern, label } of forbiddenText) {
      if (pattern.test(text)) {
        fail(`${label} appears in ${path.slice(distRoot.length + 1)}`);
      }
    }
    for (const fragment of localPathFragments) {
      if (text.includes(fragment)) {
        fail(`an absolute source path appears in ${path.slice(distRoot.length + 1)}`);
      }
    }
  }

  if (
    discoveredModelBinaries.length !== expectedModelBinaries.size ||
    [...expectedModelBinaries].some(
      (filename) => !discoveredModelBinaries.includes(filename),
    )
  ) {
    fail(`dist must contain exactly: ${[...expectedModelBinaries].join(", ")}`);
  }

  log(
    `[check-production-build] verified ${distFiles.length} dist files and ` +
      `${preparedManifest.files.length} hashed generated assets`,
  );
}

await main();
