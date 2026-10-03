"use strict";

const { spawn } = require("node:child_process");

function debuggerEndpoints(stderr) {
  return {
    node: stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1] ?? null,
    browser: stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] ?? null,
  };
}

function inspectorValue(response) {
  if (response.error) throw new Error(response.error.message ?? "Node inspector request failed");
  const exception = response.result?.exceptionDetails;
  if (exception) throw new Error(exception.exception?.description ?? exception.text ?? "Node inspector evaluation failed");
  return response.result?.result?.value;
}

function packagedWindowReady({ app, BrowserWindow }) {
  return app.isReady() && BrowserWindow.getAllWindows().some((win) =>
    !win.isDestroyed() && win.webContents.getURL() === "emotion-runner://app/" && !win.webContents.isLoading());
}

function cleanExit(result) {
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`Packaged Electron did not exit cleanly (code=${result.code}, signal=${result.signal})`);
  }
  return result;
}

async function connectInspector(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  let contextId;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.executionContextCreated" && message.params.context.auxData?.isDefault) {
      contextId = message.params.context.id;
    }
    const waiting = pending.get(message.id);
    if (waiting) { pending.delete(message.id); clearTimeout(waiting.timeout); waiting.resolve(message); }
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error("Node inspector disconnected")); }
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error("Node inspector connection timed out")); }, 10_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Node inspector connection failed")); }, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Node inspector ${method} timed out`)); }, 10_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  inspectorValue(await send("Runtime.enable"));
  return {
    async evaluate(callback) {
      return inspectorValue(await send("Runtime.evaluate", {
        expression: `(${callback.toString()})(require('electron'))`,
        contextId, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true,
      }));
    },
    close() { socket.close(); },
  };
}

async function launchPackagedElectron({ executablePath, args, env, chromium, onStderr, onStdout, timeout = 30_000 }) {
  // 配布済み exe の本物の入口を起動。-r は packaged Electron で無視される / 启动打包应用的真实入口，打包 Electron 不执行外部 -r loader。
  const child = spawn(executablePath, ["--inspect=0", "--remote-debugging-port=0", ...args], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let inspector;
  let browser;
  let closed = false;
  const exited = new Promise((resolve) => child.once("close", (code, signal) => { closed = true; inspector?.close(); resolve({ code, signal }); }));
  try {
    const endpoints = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Packaged Electron debugger startup timed out after ${timeout} ms\n${stderr}`)), timeout);
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("close", (code) => { clearTimeout(deadline); reject(new Error(`Packaged Electron exited during startup (${code})\n${stderr}`)); });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        onStderr?.(text);
        if (/Waiting for the debugger to disconnect/.test(text)) inspector?.close();
        const values = debuggerEndpoints(stderr);
        if (values.node && values.browser) { clearTimeout(deadline); resolve(values); }
      });
      child.stdout.on("data", (chunk) => onStdout?.(chunk.toString()));
    });
    inspector = await connectInspector(endpoints.node);
    // 初期ナビゲーション途中の CDP 接続は frameNavigated を取り逃す / 导航途中接入 CDP 会漏掉 frameNavigated，先等真实窗口完成本地加载。
    const readyDeadline = Date.now() + timeout;
    while (!await inspector.evaluate(packagedWindowReady)) {
      if (Date.now() >= readyDeadline) throw new Error("Packaged Electron local window did not finish loading before CDP attachment");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Node は inspector、renderer は Chromium CDP。アプリ側に橋や権限追加はしない / 测试分别连接主进程和浏览器，不增加应用桥接或权限。
    browser = await chromium.connectOverCDP(endpoints.browser, { timeout });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Packaged Electron did not expose its renderer context");
    return {
      process: () => child,
      context: () => context,
      windows: () => context.pages(),
      firstWindow: async () => context.pages()[0] ?? context.waitForEvent("page", { timeout }),
      evaluate: (callback) => inspector.evaluate(callback),
      async disconnectTestInstrumentation() {
        // 終了要求の評価が返ったら debugger を外し、自然終了を待つ / 退出请求已返回后断开测试调试器，让应用自然退出。
        inspector.close();
        await browser.close();
      },
      async waitForEvent(event, options = {}) {
        if (event !== "close") throw new Error(`Unsupported packaged test event: ${event}`);
        if (closed) return cleanExit(await exited);
        let timer;
        try { return cleanExit(await Promise.race([exited, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Packaged Electron close event timed out")), options.timeout ?? timeout);
        })])); } finally { clearTimeout(timer); }
      },
    };
  } catch (error) {
    inspector?.close();
    await browser?.close().catch(() => undefined);
    child.kill("SIGKILL");
    throw error;
  }
}

module.exports = { debuggerEndpoints, inspectorValue, packagedWindowReady, cleanExit, launchPackagedElectron };
