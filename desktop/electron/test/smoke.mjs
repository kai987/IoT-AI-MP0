// 実カメラを使わない Electron 統合確認 / 不使用真实摄像头的 Electron 集成验证。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import evidenceHelpers from "./smoke-evidence.cjs";
import packagedLauncher from "./packaged-launch.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRequire = createRequire(new URL("../../../web/package.json", import.meta.url));
const desktopRequire = createRequire(new URL("../package.json", import.meta.url));
const { _electron, chromium } = webRequire("playwright");
const { expect } = webRequire("@playwright/test");
const playwrightLoader = join(dirname(webRequire.resolve("playwright-core/package.json")), "lib/server/electron/loader.js");
const options = evidenceHelpers.smokeOptions(process.argv.slice(2));
const packagedExecutable = options.executable;

const evidenceDir = await evidenceHelpers.createEvidenceDirectory(options);
const userData = join(evidenceDir, "user-data");
const main = resolve(here, "../src/main.cjs");
const observations = { packaged: packagedExecutable !== null, evidenceDir, startedAt: new Date().toISOString(), steps: [], warnings: [], stderr: [], stdout: [], assetResponses: [] };
let application;
let page;
let failures = [];
let externalRequests = [];
let assetResponses = [];

function passed(step) {
  observations.steps.push(step);
  console.log(`PASS ${step}`);
}

async function launch() {
  const testArgs = ["--electron-smoke-test", `--test-user-data=${userData}`];
  application = packagedExecutable ? await packagedLauncher.launchPackagedElectron({
    executablePath: packagedExecutable,
    args: testArgs,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    chromium,
    onStderr: (text) => observations.stderr.push(text),
    onStdout: (text) => observations.stdout.push(text),
  }) : await _electron.launch({
    executablePath: packagedExecutable ?? desktopRequire("electron"),
    args: [
      // 明示 exe では Playwright が loader を省くため補う / 显式 exe 时 Playwright 不自动载入启动同步器。
      "-r", playwrightLoader,
      main,
      ...testArgs,
    ],
    timeout: 30_000,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
  });
  if (!packagedExecutable) {
    application.process().stderr.on("data", (value) => observations.stderr.push(value.toString()));
    application.process().stdout.on("data", (value) => observations.stdout.push(value.toString()));
  }
  page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  failures = [];
  externalRequests = [];
  assetResponses = [];
  const context = application.context();
  context.on("request", (request) => {
    if (/^https?:/.test(request.url())) externalRequests.push(request.url());
  });
  context.on("response", (response) => {
    if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`);
    if (/\/generated\/(?:models|ort|mediapipe)\//.test(response.url())) assetResponses.push({ url: response.url(), status: response.status() });
  });
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    // Emscripten は INFO/WARN も console.error へ出す / Emscripten 会把以下已知 INFO/WARN 写入 console.error。
    const runtimeDiagnostic = /\[W:onnxruntime:.*VerifyEachNodeIsAssignedToAnEp\]/.test(message.text()) ||
      message.text() === "INFO: Created TensorFlow Lite XNNPACK delegate for CPU.";
    if (message.type() === "error" && !runtimeDiagnostic) failures.push(message.text());
    if (runtimeDiagnostic) observations.warnings.push(message.text());
    if (message.type() === "warning") observations.warnings.push(message.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "Emotion Runner", exact: true })).toBeVisible();
  // 安全装置: フェイクデバイス指定がなければカメラ検証前に中止 / 未启用假设备时，在任何摄像头测试前中止。
  const fakeMedia = await application.evaluate(({ app }) => ({
    device: app.commandLine.hasSwitch("use-fake-device-for-media-stream"),
    permission: app.commandLine.hasSwitch("use-fake-ui-for-media-stream"),
  }));
  assert.deepEqual(fakeMedia, { device: true, permission: true });
}

async function close() {
  if (application) {
    const closing = application;
    application = undefined;
    let timeout;
    try {
      await Promise.race([
        (async () => {
          // 利用者と同じウィンドウ終了経路で検証 / 通过用户正常关闭窗口的路径退出，再确认进程结束。
          const closed = closing.waitForEvent("close", { timeout: 15_000 });
          void closed.catch(() => undefined);
          await closing.evaluate(({ BrowserWindow, app }) => {
            const windows = BrowserWindow.getAllWindows();
            if (windows.length === 0) app.quit();
            else for (const win of windows) win.close();
          });
          await closing.disconnectTestInstrumentation?.();
          await closed;
        })(),
        new Promise((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Electron smoke cleanup timed out after 15 seconds")), 15_000);
        }),
      ]);
    } catch (error) {
      // 自分が起動した試験プロセスだけを終了 / 只强制结束本次测试创建的进程，不影响用户应用。
      closing.process().kill("SIGKILL");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

try {
  await launch();
  assert.equal(new URL(page.url()).protocol, "emotion-runner:");
  assert.equal(new URL(page.url()).host, "app");
  assert.match(await page.title(), /Emotion Runner/);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  const security = await page.evaluate(async () => ({
    secure: isSecureContext,
    origin: location.origin,
    urlOrigin: new URL(location.href).origin,
    camera: typeof navigator.mediaDevices?.getUserMedia,
    require: typeof globalThis.require,
    process: typeof globalThis.process,
    csp: (await fetch(location.href)).headers.get("content-security-policy"),
  }));
  assert.equal(security.secure, true);
  assert.equal(security.camera, "function");
  assert.equal(security.require, "undefined");
  assert.equal(security.process, "undefined");
  assert.match(security.csp ?? "", /default-src/);
  observations.security = security;
  observations.runtime = await application.evaluate(() => ({
    electron: process.versions.electron, chromium: process.versions.chrome,
    platform: process.platform, arch: process.arch,
  }));
  observations.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const prefs = win.webContents.getLastWebPreferences();
    return { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, webSecurity: prefs.webSecurity };
  });
  assert.deepEqual(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
  await page.screenshot({ path: join(evidenceDir, "menu.png"), fullPage: true });
  passed("packaged-origin menu, secure context, CSP, sandbox, and Node isolation");

  await page.getByLabel("動作モード", { exact: true }).selectOption("economy");
  await page.getByLabel("音量", { exact: true }).fill("23");
  await page.getByRole("button", { name: "ミュート", exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("emotion-runner.web.settings") ?? "null"));
  assert.equal(saved.performanceProfile, "economy");
  assert.equal(saved.masterVolume, 0.23);
  assert.equal(saved.muted, true);
  await page.evaluate(() => {
    globalThis.__electronSmokeTracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      globalThis.__electronSmokeTracks.push(...stream.getTracks());
      return stream;
    };
  });

  await page.getByTestId("keyboard-mode").click();
  const canvas = page.getByTestId("game-canvas");
  await expect(canvas).toHaveAttribute("data-game-state", "playing");
  assert.equal(await page.evaluate(() => globalThis.__electronSmokeTracks.length), 0);
  assert.equal(assetResponses.length, 0, "keyboard-only mode must not load AI resources");
  const initialY = Number(await canvas.getAttribute("data-player-y"));
  await page.keyboard.press("Space");
  await expect.poll(async () => Number(await canvas.getAttribute("data-player-y"))).toBeLessThan(initialY);
  await page.keyboard.press("KeyS");
  await expect(canvas).toHaveAttribute("data-boosting", "true");
  await page.keyboard.press("KeyA");
  await expect(canvas).toHaveAttribute("data-attacking", "true");
  await page.keyboard.press("KeyD");
  await expect(canvas).toHaveAttribute("data-shielded", "true");
  await page.keyboard.press("KeyP");
  await expect(canvas).toHaveAttribute("data-game-state", "paused");
  await page.keyboard.press("KeyP");
  await expect(canvas).toHaveAttribute("data-game-state", "playing");
  await page.screenshot({ path: join(evidenceDir, "keyboard.png"), fullPage: true });
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await expect(page.getByTestId("keyboard-mode")).toBeVisible();
  assert.deepEqual(failures, []);
  assert.deepEqual(externalRequests, []);
  passed("keyboard jump/boost/attack/shield, pause/resume, and return to menu without AI/camera");

  await close();
  await launch();
  await expect(page.getByLabel("動作モード", { exact: true })).toHaveValue("economy");
  await expect(page.getByLabel("音量", { exact: true })).toHaveValue("23");
  await expect(page.getByRole("button", { name: "ミュートを解除", exact: true })).toHaveAttribute("aria-pressed", "true");
  passed("settings persist across complete Electron process restart in isolated user data");

  await page.evaluate(() => {
    globalThis.__electronSmokeTracks = [];
    globalThis.__electronSmokeFrameSubmissions = 0;
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...arguments_) {
      if (message?.type === "FRAME") globalThis.__electronSmokeFrameSubmissions += 1;
      return postMessage.call(this, message, ...arguments_);
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      globalThis.__electronSmokeTracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.getByTestId("camera-mode").click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing", { timeout: 90_000 });
  await expect(page.locator(".vision-stats")).toContainText(/WebGPU|WASM/);
  await expect(page.locator(".vision-stats dd").nth(3)).toHaveText(/[1-9]\d*\.\d・顔 \d+/, { timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.ok(assetResponses.some((response) => response.url.endsWith("enet_b0_8_best_vgaf.onnx") && response.status === 200), "local emotion model must load");
  assert.ok(assetResponses.some((response) => response.url.endsWith("face_landmarker.task") && response.status === 200), "local face model must load");
  assert.ok(assetResponses.some((response) => response.url.includes(".wasm") && response.status === 200), "local WASM must load");
  observations.assetResponses.push(...assetResponses);
  assert.ok(await page.evaluate(() => globalThis.__electronSmokeTracks.some((track) => track.readyState === "live")));
  await page.screenshot({ path: join(evidenceDir, "synthetic-camera.png"), fullPage: true });

  // visibility 境界を合成し、実 Worker への新規 FRAME 停止を検証 / 合成可见性事件，验证真实 Worker 暂停新帧。
  // Playwright は可視状態を強制するため、ネイティブ hide の実機受入とは区別 / Playwright 会固定可见状态，此项不等于原生隐藏窗口验收。
  await expect.poll(() => page.evaluate(() => globalThis.__electronSmokeFrameSubmissions)).toBeGreaterThan(1);
  await page.evaluate(() => {
    globalThis.__electronSmokeHidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => globalThis.__electronSmokeHidden });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await page.evaluate(() => document.hidden), true);
  await expect(page.locator(".video-status")).toHaveText("バックグラウンド中・AIを一時停止");
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "paused");
  const hiddenFrameCount = await page.evaluate(() => globalThis.__electronSmokeFrameSubmissions);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await page.evaluate(() => globalThis.__electronSmokeFrameSubmissions), hiddenFrameCount,
    "a suspended application must not submit new inference frames");
  await page.evaluate(() => {
    globalThis.__electronSmokeHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.hidden;
    delete globalThis.__electronSmokeHidden;
  });
  assert.equal(await page.evaluate(() => document.hidden), false);
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "paused");
  await expect.poll(() => page.evaluate(() => globalThis.__electronSmokeFrameSubmissions), { timeout: 30_000 }).toBeGreaterThan(hiddenFrameCount);
  await page.locator(".vision-diagnostics summary").click();
  const timingValues = page.locator(".vision-timings dd");
  await expect(timingValues.nth(1)).toHaveText(/^\d+ ms \/ \d+ ms$/, { timeout: 30_000 });
  const timingText = await timingValues.allTextContents();
  const [p50, p95] = timingText[1].match(/\d+/g).map(Number);
  assert.ok(Number.isFinite(p50) && Number.isFinite(p95) && p95 >= p50);
  for (const text of timingText) assert.match(text, /^\d+ ms(?: \/ \d+ ms)?$/);
  observations.backgroundLifecycle = { visibilityMode: "synthetic-document-boundary", hiddenFrameCount, resumedFrameCount: await page.evaluate(() => globalThis.__electronSmokeFrameSubmissions), hiddenObservationMs: 600 };
  observations.timings = { p50Ms: p50, p95Ms: p95, displayedValues: timingText };
  await page.screenshot({ path: join(evidenceDir, "timing-and-resumed-camera.png"), fullPage: true });
  await page.getByTestId("game-canvas").focus();
  await page.keyboard.press("KeyP");
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing");
  passed("synthetic visibility boundary stops inference; resume gets fresh AI but gameplay requires P; finite latency/stage metrics render");

  await page.getByRole("button", { name: "カメラを停止", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => globalThis.__electronSmokeTracks.every((track) => track.readyState === "ended"))).toBe(true);
  await expect.poll(() => page.workers().length, { timeout: 10_000 }).toBe(0);
  assert.deepEqual(failures, []);
  assert.deepEqual(externalRequests, []);
  passed("synthetic camera, real local model loading and Worker inference, then track/Worker shutdown");

  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByTestId("keyboard-mode").click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing");
  await application.evaluate(({ BrowserWindow }) => {
    globalThis.__smokeEnteredFullscreen = false;
    globalThis.__smokeLeftFullscreen = false;
    const win = BrowserWindow.getAllWindows()[0];
    win.once("enter-full-screen", () => { globalThis.__smokeEnteredFullscreen = true; });
    win.once("leave-full-screen", () => { globalThis.__smokeLeftFullscreen = true; });
  });
  await page.getByRole("button", { name: "全画面", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null), { timeout: 10_000 }).toBe(true);
  // macOS のネイティブ遷移が完了するまで待つ / 等待 macOS 原生全屏动画完成后再退出。
  await expect.poll(() => application.evaluate(({ BrowserWindow }) =>
    globalThis.__smokeEnteredFullscreen && BrowserWindow.getAllWindows()[0].isFullScreen()), { timeout: 10_000 }).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => application.evaluate(({ BrowserWindow }) =>
    globalThis.__smokeLeftFullscreen && !BrowserWindow.getAllWindows()[0].isFullScreen()), { timeout: 10_000 }).toBe(true);
  passed("fullscreen button enters and Escape exits fullscreen");

  // Electron の拒否済みナビゲーションを DOM と主プロセスの両方で確認 / 从 DOM 与主进程双重确认导航已拒绝。
  if (await page.getByRole("button", { name: "メニュー", exact: true }).count()) {
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Emotion Runner", exact: true })).toBeVisible();
  const initialUrl = page.url();
  const windowCount = application.windows().length;
  await page.evaluate(() => window.open("https://example.invalid/electron-smoke-popup", "_blank"));
  await page.evaluate(() => location.assign("https://example.invalid/electron-smoke-navigation"));
  assert.equal(await page.evaluate(() => document.querySelector("#game-title")?.textContent), "Emotion Runner");
  assert.equal(page.url(), initialUrl);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL()), initialUrl);
  assert.equal(application.windows().length, windowCount);
  const denyResult = await page.evaluate(async () => {
    try { await fetch("https://example.invalid/electron-smoke-fetch"); return false; }
    catch { return true; }
  });
  assert.equal(denyResult, true);
  observations.policyCheckMessages = [...failures];
  // 意図的な CSP 拒否と本当の不具合を分離 / 将故意触发的 CSP 拦截与真正的运行错误分开。
  assert.deepEqual(failures.filter((message) => !(message.includes("https://example.invalid/electron-smoke-fetch") &&
    /Content Security Policy|content security policy/.test(message))), []);
  failures = [];
  passed("external navigation, popup, and network fetch are denied");

  observations.result = "passed";
} catch (error) {
  observations.result = "failed";
  observations.error = String(error?.stack ?? error);
  observations.failurePageState = await page?.evaluate(() => ({ hidden: document.hidden, url: location.href,
    gameState: document.querySelector('[data-testid="game-canvas"]')?.getAttribute("data-game-state") })).catch(() => undefined);
  // 非表示エラーでも撮影できるようウィンドウだけ戻す / 隐藏窗口测试失败时，先恢复窗口以保存截图。
  await application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show()).catch(() => undefined);
  await page?.screenshot({ path: join(evidenceDir, "failure.png"), fullPage: true, timeout: 5_000 }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
} finally {
  // 終了処理が失敗しても証拠を残す / 清理失败也必须保留结果、日志和已有截图。
  try {
    await close();
  } catch (error) {
    observations.result = "failed";
    observations.cleanupError = String(error?.stack ?? error);
    console.error(error);
    process.exitCode = 1;
  }
  observations.finishedAt = new Date().toISOString();
  observations.failures = failures;
  observations.externalRequests = externalRequests;
  observations.assetResponses = [...new Map([...observations.assetResponses, ...assetResponses].map((response) => [response.url, response])).values()];
  try {
    await evidenceHelpers.writeSmokeEvidence(evidenceDir, observations, userData);
  } catch (error) {
    console.error("Could not save smoke evidence:", error);
    process.exitCode = 1;
  }
  console.log(`Evidence: ${evidenceDir}`);
}
