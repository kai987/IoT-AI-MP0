// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisionWorkerRequest, VisionWorkerResponse } from "./workerProtocol";

const mocks = vi.hoisted(() => ({
  detect: vi.fn(), align: vi.fn(), classify: vi.fn(), closeClassifier: vi.fn(),
  closeLandmarker: vi.fn(), disposeAligner: vi.fn(), post: vi.fn<(response: VisionWorkerResponse) => void>(),
}));
vi.mock("./FaceAlignment", () => ({ FaceAligner: class { align = mocks.align; dispose = mocks.disposeAligner; } }));
vi.mock("./FaceLandmarkerRuntime", () => ({ FaceLandmarkerRuntime: class {
  static create() { return Promise.resolve({ detect: mocks.detect, close: mocks.closeLandmarker }); }
} }));
vi.mock("./EmotionClassifier", () => ({ EmotionClassifier: class {
  static create() { return Promise.resolve({ provider: "wasm", fallbackReason: null, classify: mocks.classify, close: mocks.closeClassifier }); }
} }));

let dispatch: (request: VisionWorkerRequest) => void;
function resultMessages() { return mocks.post.mock.calls.map(([message]) => message).filter((message) => message.type === "RESULT"); }

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("postMessage", mocks.post);
  vi.stubGlobal("addEventListener", (_type: string, listener: (event: MessageEvent<unknown>) => void) => {
    dispatch = (request) => listener({ data: request } as MessageEvent<unknown>);
  });
  const data = new Uint8ClampedArray(224 * 224 * 4);
  for (let index = 0; index < 224 * 224; index += 1) {
    const value = (index + Math.floor(index / 224)) % 2 === 0 ? 90 : 170;
    data.set([value, value, value, 255], index * 4);
  }
  mocks.align.mockReturnValue({ imageData: { width: 224, height: 224, data } });
  mocks.detect.mockReturnValue({ faceCount: 1, primaryFace: {
    pixelBox: { x: 10, y: 10, width: 128, height: 128 },
    normalizedBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, fivePoints: [],
    features: { mouthOpenRatio: 0.1, jawOpen: 0.1, browRaise: 0.2, browFurrow: 0.1, smile: 0.8, eyeWide: 0.1 },
  } });
  mocks.classify.mockResolvedValue([0.02, 0.02, 0.02, 0.02, 0.8, 0.04, 0.04, 0.04]);
  mocks.closeClassifier.mockResolvedValue(undefined);
  await import("./emotion.worker");
  dispatch({ type: "INIT", assets: { emotionModelUrl: "/emotion", faceLandmarkerModelUrl: "/face", mediaPipeWasmRoot: "/mp", ortWasmRoot: "/ort" } });
  await vi.waitFor(() => expect(mocks.post.mock.calls.some(([message]) => message.type === "READY")).toBe(true));
});
afterEach(() => vi.unstubAllGlobals());

describe("vision Worker pipeline boundaries", () => {
  it("returns finite stage timings and aligned eight-class results", async () => {
    const close = vi.fn();
    dispatch({ type: "FRAME", frameId: 0, timestampMs: 100, bitmap: { width: 640, height: 360, close } });
    await vi.waitFor(() => expect(resultMessages()).toHaveLength(1));
    const result = resultMessages()[0]?.result;
    expect(result?.emotion).toBe("happiness");
    expect(Object.values(result?.stageTimings ?? {})).toHaveLength(4);
    expect(Object.values(result?.stageTimings ?? {}).every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([480, 640, 960])("rejects a proportionally small face before alignment/classification at %i pixels", async (width) => {
    const detection: unknown = mocks.detect();
    if (typeof detection !== "object" || detection === null) throw new Error("Missing mock detection");
    mocks.detect.mockReturnValue({ ...detection, primaryFace: { pixelBox: { x: 10, y: 10, width: width * 0.1, height: width * 0.1 }, normalizedBox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } } });
    dispatch({ type: "FRAME", frameId: 0, timestampMs: 100, bitmap: { width, height: Math.round(width * 9 / 16), close: vi.fn() } });
    await vi.waitFor(() => expect(resultMessages()).toHaveLength(1));
    expect(resultMessages()[0]?.result.qualityIssue).toBe("small");
    expect(resultMessages()[0]?.result.stageTimings?.classificationMs).toBe(0);
    expect(mocks.align).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it.each(["RESET", "UPDATE_OPTIONS", "STOP"] as const)("drops old async classification failures after %s", async (type) => {
    let rejectInference: ((error: Error) => void) | undefined;
    mocks.classify.mockImplementationOnce(() => new Promise((_, reject) => { rejectInference = reject; }));
    dispatch({ type: "FRAME", frameId: 0, timestampMs: 100, bitmap: { width: 640, height: 360, close: vi.fn() } });
    await vi.waitFor(() => expect(mocks.classify).toHaveBeenCalledOnce());
    dispatch(type === "UPDATE_OPTIONS" ? { type, options: { switchConfirmationMs: 150 } } : { type });
    rejectInference?.(new Error("old inference failure"));
    await vi.waitFor(() => expect(mocks.post.mock.calls.some(([message]) => message.type === "WARNING" && message.frameId === 0)).toBe(true));
    expect(mocks.post.mock.calls.some(([message]) => message.type === "ERROR")).toBe(false);
    expect(resultMessages()).toHaveLength(0);
  });

  it("drops a successful in-flight result on RESET, then accepts a new frame", async () => {
    let resolveInference: ((values: number[]) => void) | undefined;
    mocks.classify.mockImplementationOnce(() => new Promise((resolve) => { resolveInference = resolve; }));
    dispatch({ type: "FRAME", frameId: 0, timestampMs: 100, bitmap: { width: 640, height: 360, close: vi.fn() } });
    dispatch({ type: "RESET" });
    resolveInference?.([0.02, 0.02, 0.02, 0.02, 0.8, 0.04, 0.04, 0.04]);
    await vi.waitFor(() => expect(mocks.post.mock.calls.some(([message]) => message.type === "WARNING")).toBe(true));
    expect(resultMessages()).toHaveLength(0);
    dispatch({ type: "FRAME", frameId: 1, timestampMs: 200, bitmap: { width: 640, height: 360, close: vi.fn() } });
    await vi.waitFor(() => expect(resultMessages()).toHaveLength(1));
    expect(resultMessages()[0]?.result.frameId).toBe(1);
  });

  it("reports a current-frame inference failure as recoverable and can retry", async () => {
    mocks.classify.mockRejectedValueOnce(new Error("current inference failure"));
    dispatch({ type: "FRAME", frameId: 0, timestampMs: 100, bitmap: { width: 640, height: 360, close: vi.fn() } });
    await vi.waitFor(() => expect(mocks.post.mock.calls.some(([message]) => message.type === "ERROR" && message.recoverable && message.frameId === 0)).toBe(true));
    dispatch({ type: "FRAME", frameId: 1, timestampMs: 200, bitmap: { width: 640, height: 360, close: vi.fn() } });
    await vi.waitFor(() => expect(resultMessages()).toHaveLength(1));
  });
});
