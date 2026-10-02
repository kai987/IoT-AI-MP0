"use strict";

const APP_SCHEME = "emotion-runner";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const APP_URL = `${APP_ORIGIN}/`;

// カスタム URL の origin は Node では null / Node 中自定义协议的 origin 可能为 null，逐项验证。
function isTrustedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === `${APP_SCHEME}:` && url.hostname === "app" &&
      url.port === "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isTrustedPermissionContext(pageUrl, requestingUrl, details = {}) {
  return isTrustedUrl(pageUrl) && isTrustedUrl(requestingUrl) &&
    details.isMainFrame === true &&
    (details.securityOrigin === undefined || isTrustedUrl(details.securityOrigin)) &&
    (details.embeddingOrigin === undefined || isTrustedUrl(details.embeddingOrigin));
}

function allowPermissionCheck(pageUrl, permission, requestingOrigin, details = {}) {
  if (!isTrustedPermissionContext(pageUrl, requestingOrigin, details) ||
    (details.requestingUrl !== undefined && !isTrustedUrl(details.requestingUrl))) return false;
  // ゲーム内の全画面ボタンだけを許可 / 允许本地游戏的全屏按钮，自动全屏等其他权限仍拒绝。
  return permission === "fullscreen" || (permission === "media" && details.mediaType === "video");
}

function allowPermissionRequest(pageUrl, permission, details = {}) {
  if (!isTrustedPermissionContext(pageUrl, details.requestingUrl, details)) return false;
  return permission === "fullscreen" || (permission === "media" &&
    Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 &&
    details.mediaTypes[0] === "video");
}

// WASM とローカル Worker だけを許可 / 仅允许 WASM 与本地 Worker；禁止远程连接和任意 JS eval。
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), display-capture=(), usb=(), serial=()",
});

module.exports = {
  APP_SCHEME, APP_ORIGIN, APP_URL, isTrustedUrl,
  allowPermissionCheck, allowPermissionRequest,
  CONTENT_SECURITY_POLICY, SECURITY_HEADERS,
};
