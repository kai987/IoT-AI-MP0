"use strict";

const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { isAbsolute, join, resolve } = require("node:path");

function smokeOptions(args = [], env = process.env) {
  const value = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
    return args[index + 1];
  };
  const executable = value("--executable") ?? null;
  if (executable !== null && !isAbsolute(executable)) throw new Error("--executable requires an absolute executable path");
  const root = value("--evidence-dir") ?? env.EMOTION_RUNNER_SMOKE_EVIDENCE_DIR ?? tmpdir();
  const label = value("--evidence-label") ?? (executable ? "packaged" : "development");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(label)) throw new Error("--evidence-label requires a short alphanumeric label");
  return { executable, evidenceRoot: resolve(root), label };
}

async function createEvidenceDirectory({ evidenceRoot, label }) {
  await mkdir(evidenceRoot, { recursive: true });
  // 各実行に固有のフォルダーを使う / 每次运行创建独立目录，开发与打包测试不会覆盖。
  return mkdtemp(join(evidenceRoot, `emotion-runner-${label}-`));
}

async function writeSmokeEvidence(evidenceDir, observations, userData) {
  let diagnosticError;
  try {
    await writeFile(join(evidenceDir, "electron.stderr.log"), observations.stderr.join(""));
    await writeFile(join(evidenceDir, "electron.stdout.log"), observations.stdout.join(""));
    if (userData) {
      const desktopLog = await readFile(join(userData, "desktop.log"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      await writeFile(join(evidenceDir, "desktop.log"), desktopLog);
    }
  } catch (error) {
    diagnosticError = error;
    observations.result = "failed";
    observations.evidenceError = String(error?.stack ?? error);
  } finally {
    // ログ収集エラーでも結果は残す / 日志收集出错时，也要保留结果文件。
    await writeFile(join(evidenceDir, "result.json"), `${JSON.stringify(observations, null, 2)}\n`);
  }
  if (diagnosticError) throw diagnosticError;
}

module.exports = { smokeOptions, createEvidenceDirectory, writeSmokeEvidence };
