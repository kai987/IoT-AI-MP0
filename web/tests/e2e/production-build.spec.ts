import { expect, test } from "@playwright/test";

test("production build serves local models and runtimes without 404 responses", async ({ page, request }) => {
  const failed: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 404) {
      failed.push(response.url());
    }
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Emotion Runner");
  const required = [
    "/generated/models/enet_b0_8_best_vgaf.onnx",
    "/generated/models/face_landmarker.task",
    "/generated/ort/asset-manifest.json",
    "/generated/ort/ort-wasm-simd-threaded.jsep.wasm.gzip",
    "/generated/mediapipe/vision_wasm_module_internal.js",
    "/generated/mediapipe/vision_wasm_module_internal.wasm",
  ];
  for (const path of required) {
    const response = await request.get(path, { headers: { Range: "bytes=0-31" } });
    expect([200, 206]).toContain(response.status());
  }
  expect(failed).toEqual([]);
});
