"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { isTrustedUrl, SECURITY_HEADERS } = require("./policy.cjs");

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".task": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".data": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
});

function withinDirectory(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assetPathname(rawUrl) {
  if (!isTrustedUrl(rawUrl)) return null;
  try {
    const pathname = decodeURIComponent(new URL(rawUrl).pathname);
    if (/[\\\0]/.test(pathname) || pathname.split("/").some((segment) => segment === ".." || segment === ".")) return null;
    if (pathname === "/") return "/index.html";
    // 配布する Web 資産のみ / 仅提供构建后的网页资源，不暴露运行时源码和本地文件。
    if (["/index.html", "/favicon.svg", "/favicon.ico", "/og.png"].includes(pathname)) return pathname;
    if (!pathname.startsWith("/assets/") && !pathname.startsWith("/generated/")) return null;
    return MIME_TYPES[path.extname(pathname).toLowerCase()] ? pathname : null;
  } catch {
    return null;
  }
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const first = match[1] === "" ? null : Number(match[1]);
  const last = match[2] === "" ? null : Number(match[2]);
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return false;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  return start > end || start >= size ? false : { start, end };
}

function errorResponse(status, message, extraHeaders = {}) {
  return new Response(message, { status, headers: {
    ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders,
  } });
}

function createAssetHandler(webRoot) {
  const absoluteRoot = path.resolve(webRoot);
  return async (request) => {
    if (!["GET", "HEAD"].includes(request.method)) return errorResponse(405, "Method not allowed", { Allow: "GET, HEAD" });
    if (request.initiatorOrigin !== undefined && !isTrustedUrl(request.initiatorOrigin)) return errorResponse(403, "Forbidden");
    const pathname = assetPathname(request.url);
    if (pathname === null) return errorResponse(404, "Not found");
    try {
      const filename = path.resolve(absoluteRoot, `.${pathname}`);
      if (!withinDirectory(absoluteRoot, filename)) return errorResponse(404, "Not found");
      // symlink でも配布フォルダー外には出ない / 即使存在符号链接，也禁止读取资源目录之外。
      const [realRoot, realFile] = await Promise.all([
        fs.promises.realpath(absoluteRoot), fs.promises.realpath(filename),
      ]);
      if (!withinDirectory(realRoot, realFile)) return errorResponse(404, "Not found");
      const stat = await fs.promises.stat(realFile);
      if (!stat.isFile()) return errorResponse(404, "Not found");
      const range = parseRange(request.headers.get("range"), stat.size);
      if (range === false) return errorResponse(416, "Range not satisfiable", { "Content-Range": `bytes */${stat.size}` });
      const headers = {
        ...SECURITY_HEADERS,
        "Content-Type": MIME_TYPES[path.extname(realFile).toLowerCase()] || "application/octet-stream",
        "Content-Length": String(range ? range.end - range.start + 1 : stat.size),
        "Accept-Ranges": "bytes",
        // 同名モデルを更新しても古いキャッシュを使わない / 模型文件名不变时，更新应用也不会误用旧缓存。
        "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=3600" : "no-cache",
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}` } : {}),
      };
      // 大きなモデルを一括コピーしない / 大模型采用流式读取，避免整份复制进主进程内存。
      const body = request.method === "HEAD" || stat.size === 0 ? null : Readable.toWeb(fs.createReadStream(realFile, range || undefined));
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return errorResponse(404, "Not found");
      // ローカルパスを応答へ含めない / 错误响应不泄露本地路径。
      return errorResponse(500, "Asset could not be read");
    }
  };
}

module.exports = { assetPathname, parseRange, createAssetHandler, withinDirectory };
