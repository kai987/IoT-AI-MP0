// 既存Webの検証済み配布物を同梱 / 复用现有Web构建和资源校验，不改动Python版。
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(root, "../../web");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Use npm run build from desktop/electron.");
const result = spawnSync(process.execPath, [npmCli, "run", "build"], {
  cwd: webRoot,
  stdio: "inherit",
  // Pagesのサブパスをデスクトップへ持ち込まない / 不将Pages子路径带入桌面包。
  env: { ...process.env, VITE_BASE_PATH: "/" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const source = join(webRoot, "dist/client");
const html = await readFile(join(source, "index.html"), "utf8");
if (!html.includes('src="/assets/') || /(?:src|href)="https?:\/\//.test(html)) {
  throw new Error("Electron requires local assets built for the root path.");
}
const destination = join(root, "web");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`[electron] Local Web + AI assets prepared: ${destination}`);
