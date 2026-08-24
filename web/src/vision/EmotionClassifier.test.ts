import { describe, expect, it, vi } from "vitest";

import {
  EmotionClassifier,
  resolveLocalAssetUrl,
  type OrtRuntimeLike,
  type OrtSessionLike,
  type OrtTensorLike,
} from "./EmotionClassifier";
import { EMOTION_INPUT_SIZE } from "./preprocessing";

function emotionImage(): ImageData {
  return {
    width: EMOTION_INPUT_SIZE,
    height: EMOTION_INPUT_SIZE,
    data: new Uint8ClampedArray(
      EMOTION_INPUT_SIZE * EMOTION_INPUT_SIZE * 4,
    ),
    colorSpace: "srgb",
  };
}

function session(
  scores: ArrayLike<number>,
  outputShape: readonly (number | string)[] = [1, 8],
) {
  return {
    inputNames: ["input"],
    outputNames: ["output"],
    outputMetadata: [{ shape: outputShape }],
    run: vi.fn((feeds: Readonly<Record<string, OrtTensorLike>>) => {
      void feeds;
      return Promise.resolve({
        output: { data: Float32Array.from(scores) },
      });
    }),
    release: vi.fn(() => Promise.resolve()),
  } satisfies OrtSessionLike;
}

function runtime(
  create: OrtRuntimeLike["InferenceSession"]["create"],
): OrtRuntimeLike {
  class Tensor {
    public constructor(
      public readonly type: "float32",
      public readonly data: Float32Array,
      public readonly dimensions: readonly number[],
    ) {}
  }

  return {
    env: { wasm: {} },
    Tensor,
    InferenceSession: { create },
  };
}

describe("EmotionClassifier", () => {
  it("falls back from WebGPU to a newly created WASM session", async () => {
    const wasmSession = session([0, 0, 0, 0, 4, 0, 0, 0]);
    const createSpy = vi.fn();
    let attempt = 0;
    const create = (
      modelUrl: string,
      options: Readonly<Record<string, unknown>>,
    ): Promise<OrtSessionLike> => {
      createSpy(modelUrl, options);
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("adapter unavailable"))
        : Promise.resolve(wasmSession);
    };
    const ort = runtime(create);
    const classifier = await EmotionClassifier.create({
      modelUrl: "/generated/models/emotion.onnx",
      ortWasmRoot: "/generated/ort/",
      ort,
      webGpuAvailable: true,
    });

    expect(classifier.provider).toBe("wasm");
    expect(classifier.fallbackReason).toContain("adapter unavailable");
    expect(createSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/generated/models/emotion.onnx"),
      expect.objectContaining({ executionProviders: ["webgpu"] }),
    );
    expect(createSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/generated/models/emotion.onnx"),
      expect.objectContaining({ executionProviders: ["wasm"] }),
    );
    expect(ort.env.wasm.wasmPaths).toBe(
      `${window.location.origin}/generated/ort/`,
    );
    expect(ort.env.wasm.numThreads).toBeGreaterThanOrEqual(1);

    const probabilities = await classifier.classify(emotionImage());
    expect(probabilities).toHaveLength(8);
    expect(probabilities[4]).toBeGreaterThan(0.8);
    expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    await classifier.close();
    await classifier.close();
    expect(wasmSession.release).toHaveBeenCalledOnce();
  });

  it("rejects a model whose static output contract is not eight-class", async () => {
    const invalidSession = session([0, 0, 0, 0, 0, 0, 0], [1, 7]);
    const create = (): Promise<OrtSessionLike> => Promise.resolve(invalidSession);
    await expect(
      EmotionClassifier.create({
        modelUrl: "/generated/models/emotion.onnx",
        ortWasmRoot: "/generated/ort/",
        ort: runtime(create),
        webGpuAvailable: false,
      }),
    ).rejects.toThrow(/eight-class/);
  });

  it("rebuilds on WASM and retries once after a WebGPU device loss", async () => {
    const webGpuSession = session([0, 0, 0, 0, 0, 0, 0, 0]);
    webGpuSession.run.mockRejectedValueOnce(new Error("GPU device lost"));
    const wasmSession = session([0, 0, 0, 0, 0, 0, 0, 5]);
    const createSpy = vi.fn();
    let attempt = 0;
    const create = (
      modelUrl: string,
      options: Readonly<Record<string, unknown>>,
    ): Promise<OrtSessionLike> => {
      createSpy(modelUrl, options);
      attempt += 1;
      return Promise.resolve(attempt === 1 ? webGpuSession : wasmSession);
    };
    const classifier = await EmotionClassifier.create({
      modelUrl: "/generated/models/emotion.onnx",
      ortWasmRoot: "/generated/ort/",
      ort: runtime(create),
      webGpuAvailable: true,
    });

    expect(classifier.provider).toBe("webgpu");
    const probabilities = await classifier.classify(emotionImage());

    expect(classifier.provider).toBe("wasm");
    expect(classifier.fallbackReason).toContain("GPU device lost");
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenLastCalledWith(
      expect.stringContaining("/generated/models/emotion.onnx"),
      expect.objectContaining({ executionProviders: ["wasm"] }),
    );
    expect(webGpuSession.release).toHaveBeenCalledOnce();
    expect(wasmSession.run).toHaveBeenCalledOnce();
    expect(probabilities[7]).toBeGreaterThan(0.9);
  });

  it("rejects a malformed runtime output even with dynamic metadata", async () => {
    const badSession = session([0, 0, 0, 0, 0, 0, 0], []);
    badSession.outputMetadata = [{ shape: ["batch", "classes"] }];
    const create = (): Promise<OrtSessionLike> => Promise.resolve(badSession);
    const classifier = await EmotionClassifier.create({
      modelUrl: "/generated/models/emotion.onnx",
      ortWasmRoot: "/generated/ort/",
      ort: runtime(create),
      webGpuAvailable: false,
    });

    await expect(classifier.classify(emotionImage())).rejects.toThrow(
      /exactly 8/,
    );
  });

  it("allows same-origin assets and rejects a remote origin", () => {
    expect(resolveLocalAssetUrl("/generated/model.onnx")).toBe(
      `${window.location.origin}/generated/model.onnx`,
    );
    expect(() =>
      resolveLocalAssetUrl("https://invalid.example/model.onnx"),
    ).toThrow(/Cross-origin/);
  });
});
