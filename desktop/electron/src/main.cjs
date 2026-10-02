"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, protocol, session } = require("electron");
const { createAssetHandler } = require("./assets.cjs");
const { APP_SCHEME, APP_URL, isTrustedUrl, allowPermissionCheck, allowPermissionRequest } = require("./policy.cjs");

const APP_NAME = "Emotion Runner Electron";
const smokeTest = process.argv.includes("--electron-smoke-test");
const testDataArgument = process.argv.find((value) => value.startsWith("--test-user-data="));
app.setName(APP_NAME);

// Python 版と設定を分離 / Electron 设置与现有 Python App 完全分离。
let dataDirectory = path.join(app.getPath("appData"), APP_NAME);
if (smokeTest) {
  if (!testDataArgument || !path.isAbsolute(testDataArgument.slice("--test-user-data=".length))) {
    throw new Error("Smoke test requires an absolute --test-user-data path");
  }
  dataDirectory = testDataArgument.slice("--test-user-data=".length);
  // 自動試験では実カメラを一切開かない / 自动测试仅使用合成摄像头，不打开真实摄像头。
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}
fs.mkdirSync(dataDirectory, { recursive: true });
app.setPath("userData", dataDirectory);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

let mainWindow = null;
let quitting = false;
let reportingFailure = false;

function writeLog(event, detail = "") {
  try {
    const filename = path.join(app.getPath("userData"), "desktop.log");
    if (fs.existsSync(filename) && fs.statSync(filename).size > 1024 * 1024) {
      fs.rmSync(`${filename}.1`, { force: true });
      fs.renameSync(filename, `${filename}.1`);
    }
    fs.appendFileSync(filename, `${new Date().toISOString()} ${event} ${detail}\n`, "utf8");
  } catch {
    // ログ失敗でゲームを停止しない / 日志写入失败不阻止游戏。
  }
}

function reportFailure(message, detail = "") {
  writeLog("failure", detail);
  if (quitting || reportingFailure) return;
  reportingFailure = true;
  if (smokeTest) {
    console.error(message, detail);
    app.exit(1);
    return;
  }
  dialog.showErrorBox("Emotion Runner を開始できませんでした", message);
  app.quit();
}

function installSessionPolicy() {
  const currentSession = session.defaultSession;
  currentSession.protocol.handle(APP_SCHEME, createAssetHandler(path.join(__dirname, "../web")));
  const pageUrl = (contents) => contents && contents === mainWindow?.webContents && !contents.isDestroyed() ? contents.getURL() : "";
  currentSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allowPermissionCheck(pageUrl(contents), permission, requestingOrigin, details));
  currentSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowPermissionRequest(pageUrl(contents), permission, details)));
  currentSession.setDevicePermissionHandler(() => false);
  currentSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  currentSession.on("will-download", (event) => event.preventDefault());
  // オフライン専用。HTTP サーバーも外部通信も不要 / 离线运行，不启动 HTTP 服务且禁止外部网络请求。
  currentSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*", "file://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: smokeTest ? `${APP_NAME} — テスト用カメラ` : APP_NAME,
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#071327",
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged || smokeTest,
      spellcheck: false,
      autoplayPolicy: "user-gesture-required",
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event) => { if (!isTrustedUrl(event.url)) event.preventDefault(); });
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isTrustedUrl(event.url)) event.preventDefault();
  });
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("render-process-gone", (_event, details) => {
    if (quitting) return;
    reportFailure("画面処理が終了しました。アプリを再起動してください。", `${details.reason} (${details.exitCode})`);
  });
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) reportFailure("ゲームのファイルを読み込めませんでした。アプリを再インストールしてください。", `load ${code}`);
  });
  void mainWindow.loadURL(APP_URL).catch(() => reportFailure("ゲームを開けませんでした。アプリを再起動してください。", "loadURL"));
}

function installMenu() {
  const applicationMenu = {
    label: APP_NAME,
    submenu: [
      { label: "Emotion Runner について", click: () => dialog.showMessageBox({ type: "info", title: APP_NAME,
        message: APP_NAME, detail: `バージョン ${app.getVersion()}\nカメラ映像と AI 推論はこの端末内だけで処理します。\nPython 版のアプリ・設定には影響しません。` }) },
      { type: "separator" },
      ...(process.platform === "darwin" ? [{ label: "隠す", role: "hide" }, { label: "すべて表示", role: "unhide" }, { type: "separator" }] : []),
      { label: "終了", role: "quit" },
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    applicationMenu,
    { label: "表示", submenu: [
      { label: "ゲームを再読み込み", role: "reload" },
      { label: "全画面表示", role: "togglefullscreen" },
      { type: "separator" },
      { label: "拡大", role: "zoomIn" },
      { label: "縮小", role: "zoomOut" },
      { label: "実際のサイズ", role: "resetZoom" },
    ] },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    installSessionPolicy();
    installMenu();
    createWindow();
    writeLog("started", `v${app.getVersion()} ${process.platform}/${process.arch} smoke=${smokeTest}`);
  }).catch(() => reportFailure("アプリの準備に失敗しました。再起動してください。", "initialization"));
  app.on("activate", () => { if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // ウィンドウを閉じたらカメラも終了 / 关闭最后一个窗口即退出，避免摄像头在后台继续运行。
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { quitting = true; });
}
