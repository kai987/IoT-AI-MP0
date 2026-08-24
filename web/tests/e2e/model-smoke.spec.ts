import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("real ONNX model returns stable finite eight-class WASM output", async ({ page }) => {
  await page.goto("/");
  // Use the public package export that matches the production WebGPU/WASM
  // bundle. Reaching into dist/ is blocked by modern package exports and can
  // silently diverge from the runtime files copied by prepare-assets.mjs.
  const ortScript = require.resolve("onnxruntime-web/webgpu");
  await page.addScriptTag({ path: ortScript });
  const result = await page.evaluate(async () => {
    interface OrtGlobal {
      env: { wasm: { wasmPaths: string; numThreads: number } };
      Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
      InferenceSession: {
        create(url: string, options: object): Promise<{
          inputNames: string[];
          outputNames: string[];
          run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
        }>;
      };
    }
    const ort = Reflect.get(globalThis, "ort") as OrtGlobal;
    ort.env.wasm.wasmPaths = new URL("generated/ort/", document.baseURI).href;
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(
      new URL("generated/models/enet_b0_8_best_vgaf.onnx", document.baseURI).href,
      { executionProviders: ["wasm"] },
    );
    const input = new Float32Array(1 * 3 * 224 * 224);
    const tensor = new ort.Tensor("float32", input, [1, 3, 224, 224]);
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (inputName === undefined || outputName === undefined) {
      throw new Error("Model tensor names are missing");
    }
    const first = Array.from((await session.run({ [inputName]: tensor }))[outputName]?.data ?? []);
    const second = Array.from((await session.run({ [inputName]: tensor }))[outputName]?.data ?? []);
    return { first, second };
  });
  expect(result.first).toHaveLength(8);
  expect(result.first.every(Number.isFinite)).toBe(true);
  expect(result.second).toEqual(result.first);
});
