import { describe, expect, it, vi } from "vitest";

import type { VisionResult } from "./types";
import {
  closeFrameFromUnknownMessage,
  parseWorkerRequest,
  parseWorkerResponse,
  SingleFrameBackpressure,
  VisionProtocolError,
} from "./workerProtocol";

function bitmapLike() {
  return { width: 1280, height: 720, close: vi.fn() };
}

function imageDataLike(): ImageData {
  return {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(16),
    colorSpace: "srgb",
  };
}

function result(): VisionResult {
  return {
    frameId: 4,
    timestampMs: 123.5,
    inferenceMs: 20,
    aiFps: 12,
    faceCount: 1,
    cameraWidth: 1280,
    cameraHeight: 720,
    faceBox: { x: 0.2, y: 0.1, width: 0.4, height: 0.5 },
    emotion: "happiness",
    candidate: null,
    confidence: 0.8,
    margin: 0.6,
    uncertain: false,
    uncertaintyReason: null,
    probabilities: [0.02, 0.02, 0.02, 0.02, 0.8, 0.04, 0.04, 0.04],
    qualityIssue: null,
    features: {
      mouthOpenRatio: 0.1,
      jawOpen: 0.2,
      browRaise: 0.3,
      browFurrow: 0.1,
      smile: 0.8,
      eyeWide: 0.2,
    },
  };
}

describe("worker request protocol", () => {
  it("validates every request discriminator", () => {
    const bitmap = bitmapLike();
    const assets = {
      emotionModelUrl: "/models/emotion.onnx",
      faceLandmarkerModelUrl: "/models/face.task",
      mediaPipeWasmRoot: "/mediapipe",
      ortWasmRoot: "/ort/",
    };

    expect(parseWorkerRequest({ type: "INIT", assets })).toEqual({
      type: "INIT",
      assets,
    });
    expect(
      parseWorkerRequest({ type: "FRAME", frameId: 2, timestampMs: 10, bitmap }),
    ).toMatchObject({ type: "FRAME", frameId: 2 });
    const imageData = imageDataLike();
    expect(
      parseWorkerRequest({
        type: "FRAME",
        frameId: 3,
        timestampMs: 11,
        imageData,
      }),
    ).toEqual({ type: "FRAME", frameId: 3, timestampMs: 11, imageData });
    expect(parseWorkerRequest({ type: "RESET" })).toEqual({ type: "RESET" });
    expect(
      parseWorkerRequest({
        type: "UPDATE_OPTIONS",
        options: { confidenceThreshold: 0.5, switchConfirmations: 3 },
      }),
    ).toEqual({
      type: "UPDATE_OPTIONS",
      options: { confidenceThreshold: 0.5, switchConfirmations: 3 },
    });
    expect(parseWorkerRequest({ type: "STOP" })).toEqual({ type: "STOP" });
  });

  it.each([
    null,
    {},
    { type: "UNKNOWN" },
    { type: "FRAME", frameId: -1, timestampMs: 0, bitmap: bitmapLike() },
    {
      type: "FRAME",
      frameId: 1,
      timestampMs: 0,
      bitmap: bitmapLike(),
      imageData: imageDataLike(),
    },
    { type: "UPDATE_OPTIONS", options: { smoothingAlpha: 2 } },
  ])("rejects an invalid structured request %#", (message) => {
    expect(() => parseWorkerRequest(message)).toThrow(VisionProtocolError);
  });
});

describe("worker response protocol", () => {
  it("validates every response discriminator", () => {
    const responses = [
      { type: "INITIALIZING", stage: "runtime", message: "loading" },
      { type: "STATUS", status: "stopping", message: "stopping" },
      { type: "READY", provider: "webgpu" },
      { type: "RESULT", provider: "wasm", result: result() },
      { type: "WARNING", code: "frame-dropped", message: "busy", frameId: 4 },
      { type: "ERROR", message: "bad frame", recoverable: true, frameId: 4 },
      { type: "STOPPED" },
      { type: "METRICS", frameId: 4, inferenceMs: 20, aiFps: 12 },
    ] as const;

    for (const response of responses) {
      expect(parseWorkerResponse(response)).toEqual(response);
    }
  });

  it("rejects malformed results with an explicit protocol error", () => {
    expect(() =>
      parseWorkerResponse({
        type: "RESULT",
        provider: "wasm",
        result: { ...result(), probabilities: [1] },
      }),
    ).toThrowError(new VisionProtocolError("RESULT response is invalid"));
    expect(() =>
      parseWorkerResponse({ type: "ERROR", message: 42, recoverable: true }),
    ).toThrow(VisionProtocolError);
  });
});

describe("single-frame ownership", () => {
  it("allows only one in-flight frame and requires its matching completion", () => {
    const gate = new SingleFrameBackpressure();

    expect(gate.acquire(7)).toBe(true);
    expect(gate.inFlight).toBe(true);
    expect(gate.acquire(8)).toBe(false);
    expect(gate.complete(8)).toBe(false);
    expect(gate.complete(7)).toBe(true);
    expect(gate.acquire(8)).toBe(true);
    gate.reset();
    expect(gate.inFlight).toBe(false);
  });

  it("closes a transferred frame even when its enclosing message is invalid", () => {
    const bitmap = bitmapLike();
    closeFrameFromUnknownMessage({ type: "BROKEN", bitmap });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
