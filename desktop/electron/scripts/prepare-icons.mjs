// Webの笑顔を各OSのアイコンへ変換 / 将网页笑脸转换为各系统的应用图标。
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Icon regeneration requires macOS, iconutil, sips, and rsvg-convert.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "../../web/public/favicon.svg");
const output = join(root, "packaging");
const temporary = await mkdtemp(join(tmpdir(), "emotion-runner-icons-"));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
}
function render(size, destination) {
  run("rsvg-convert", ["--width", String(size), "--height", String(size), "--output", destination, source]);
}

try {
  await mkdir(output, { recursive: true });
  const iconset = join(temporary, "icon.iconset");
  await mkdir(iconset);
  for (const logicalSize of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const filename = `icon_${logicalSize}x${logicalSize}${scale === 2 ? "@2x" : ""}.png`;
      render(logicalSize * scale, join(iconset, filename));
    }
  }
  await copyFile(join(iconset, "icon_512x512@2x.png"), join(output, "icon.png"));
  run("iconutil", ["--convert", "icns", "--output", join(output, "icon.icns"), iconset]);

  // Windows用に小サイズも同梱 / Windows 图标同时包含小尺寸，避免任务栏图标模糊。
  const frames = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const png = join(temporary, `${size}.png`);
    const ico = join(temporary, `${size}.ico`);
    render(size, png);
    run("sips", ["--setProperty", "format", "ico", png, "--out", ico]);
    const encoded = await readFile(ico);
    if (encoded.readUInt16LE(0) !== 0 || encoded.readUInt16LE(2) !== 1) throw new Error("Invalid generated ICO");
    for (let index = 0; index < encoded.readUInt16LE(4); index += 1) {
      const entry = Buffer.from(encoded.subarray(6 + index * 16, 22 + index * 16));
      const length = entry.readUInt32LE(8);
      const offset = entry.readUInt32LE(12);
      const data = encoded.subarray(offset, offset + length);
      if (data.length !== length) throw new Error("Truncated generated ICO");
      frames.push({ entry, data });
    }
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  for (const frame of frames) {
    frame.entry.writeUInt32LE(offset, 12);
    offset += frame.data.length;
  }
  await writeFile(join(output, "icon.ico"), Buffer.concat([header, ...frames.map(({ entry }) => entry), ...frames.map(({ data }) => data)]));
  console.log("Prepared packaging/icon.png (1024px), icon.icns, and icon.ico.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
