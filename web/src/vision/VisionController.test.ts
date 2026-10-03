import { describe, expect, it, vi } from "vitest";

import { CameraController } from "./CameraController";
import {
  AdaptiveFrameRate,
  captureVideoFrame,
  VisionController,
} from "./VisionController";
import type { CameraInfo, VisionControllerEvent, VisionResult } from "./types";
import type {
  VisionWorkerRequest,
  VisionWorkerResponse,
} from "./workerProtocol";

class FakeWorker {
  private readonly messageListeners: ((event: MessageEvent<unknown>) => void)[] = [];
  private readonly errorListeners: ((event: ErrorEvent) => void)[] = [];
  public readonly messages: VisionWorkerRequest[] = [];
  public readonly terminate = vi.fn();

  public postMessage(message: VisionWorkerRequest, transfer?: Transferable[]): void {
    void transfer;
    this.messages.push(message);
    if (message.type === "INIT") {
      queueMicrotask(() => {
        this.emit({ type: "READY", provider: "wasm" });
      });
    }
    if (message.type === "STOP") {
      queueMicrotask(() => {
        this.emit({ type: "STOPPED" });
      });
    }
  }

  public addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  public addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  public addEventListener(
    type: "message" | "error",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.push(
        listener as (event: MessageEvent<unknown>) => void,
      );
    } else {
      this.errorListeners.push(listener as (event: ErrorEvent) => void);
    }
  }

  public emit(message: VisionWorkerResponse): void {
    for (const listener of this.messageListeners) {
      listener(new MessageEvent("message", { data: message }));
    }
  }
}

function fakeCamera(video: HTMLVideoElement) {
  let active = false;
  const info: CameraInfo = {
    stream: {} as MediaStream,
    deviceId: "built-in",
    label: "Built-in Camera",
    width: 1280,
    height: 720,
    frameRate: 30,
  };
  return {
    get active() {
      return active;
    },
    start: vi.fn().mockImplementation(() => {
      active = true;
      return Promise.resolve(info);
    }),
    stop: vi.fn().mockImplementation(() => {
      active = false;
      video.srcObject = null;
    }),
    getDevices: vi.fn().mockResolvedValue([]),
  };
}

function controlledVideo() {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: HTMLMediaElement.HAVE_CURRENT_DATA });
  const callbacks: VideoFrameRequestCallback[] = [];
  const cancel = vi.fn();
  Object.defineProperty(video, "requestVideoFrameCallback", { value: vi.fn((callback: VideoFrameRequestCallback) => { callbacks.push(callback); return callbacks.length; }) });
  Object.defineProperty(video, "cancelVideoFrameCallback", { value: cancel });
  return { video, callbacks, cancel };
}

function emptyVisionResult(frameId: number, timestampMs: number): VisionResult {
  return {
    frameId, timestampMs, inferenceMs: 20, aiFps: 12,
    faceCount: 0, cameraWidth: 640, cameraHeight: 360, faceBox: null,
    emotion: null, candidate: null, confidence: 0, margin: 0, uncertain: true,
    uncertaintyReason: "no-face", qualityIssue: "no-face", features: null,
    probabilities: new Array<number>(8).fill(0),
  };
}

describe("AdaptiveFrameRate", () => {
  it("stays within the 6 to 20 FPS inference budget", () => {
    const frameRate = new AdaptiveFrameRate(100);
    expect(frameRate.fps).toBe(20);
    for (let index = 0; index < 20; index += 1) {
      frameRate.observe(500);
    }
    expect(frameRate.fps).toBeGreaterThanOrEqual(6);
    expect(frameRate.fps).toBeLessThan(7);
    frameRate.reset(0);
    expect(frameRate.fps).toBe(6);
  });
});

describe("camera frame capture fallback", () => {
  it("uses Canvas ImageData when createImageBitmap is unavailable", async () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "videoWidth", { value: 640 });
    Object.defineProperty(video, "videoHeight", { value: 360 });
    const expected: ImageData = {
      width: 640,
      height: 360,
      data: new Uint8ClampedArray(640 * 360 * 4),
      colorSpace: "srgb",
    };
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => expected);
    const canvasFactory = vi.fn(() => ({
      getContext: () => ({ drawImage, getImageData }),
    }) as unknown as HTMLCanvasElement);

    const captured = await captureVideoFrame(video, null, canvasFactory);

    expect(canvasFactory).toHaveBeenCalledWith(640, 360);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 640, 360);
    expect(captured).toBe(expected);
  });
});

describe("VisionController lifecycle", () => {
  it("suspends new captures, ignores old results and resumes with fresh latency statistics", async () => {
    const { video, callbacks, cancel } = controlledVideo();
    const worker = new FakeWorker();
    const camera = fakeCamera(video);
    let now = 100;
    const createBitmap = vi.fn(() => Promise.resolve({ width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap));
    const controller = new VisionController({ camera: camera as unknown as CameraController, createWorker: () => worker, createBitmap, baseUrl: "/", now: () => now });
    const listener = vi.fn<(event: VisionControllerEvent) => void>();
    controller.subscribe(listener);
    await controller.start({ video });
    const stops = camera.stop.mock.calls.length;
    callbacks[0]?.(100, {} as VideoFrameCallbackMetadata);
    await Promise.resolve();
    expect(createBitmap).toHaveBeenCalledOnce();
    controller.setSuspended(true);
    expect(cancel).toHaveBeenCalled();
    expect(camera.stop.mock.calls.length).toBe(stops);
    callbacks[1]?.(200, {} as VideoFrameCallbackMetadata);
    worker.emit({ type: "RESULT", provider: "wasm", result: emptyVisionResult(0, 100) });
    expect(listener.mock.calls.filter(([event]) => event.type === "result")).toHaveLength(0);
    expect(createBitmap).toHaveBeenCalledOnce();
    controller.setSuspended(false);
    now = 200;
    callbacks.at(-1)?.(200, {} as VideoFrameCallbackMetadata);
    await Promise.resolve();
    now = 260;
    worker.emit({ type: "RESULT", provider: "wasm", result: emptyVisionResult(1, 200) });
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ type: "result", result: { latencyMs: 60, captureMs: 0, latencyP50Ms: 60, latencyP95Ms: 60 } });
    expect(createBitmap).toHaveBeenCalledTimes(2);
    await controller.stop();
  });

  it("closes captures started before suspension, including a quick hide/show", async () => {
    const { video, callbacks } = controlledVideo();
    const worker = new FakeWorker();
    let resolveBitmap: ((frame: ImageBitmap) => void) | undefined;
    const controller = new VisionController({ camera: fakeCamera(video) as unknown as CameraController, createWorker: () => worker, baseUrl: "/", createBitmap: () => new Promise((resolve) => { resolveBitmap = resolve; }) });
    await controller.start({ video });
    callbacks[0]?.(100, {} as VideoFrameCallbackMetadata);
    controller.setSuspended(true);
    controller.setSuspended(false);
    const close = vi.fn();
    resolveBitmap?.({ width: 640, height: 360, close });
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(worker.messages.filter((message) => message.type === "FRAME")).toHaveLength(0);
    await controller.stop();
  });

  it("does not charge background time against the first-result timeout", async () => {
    vi.useFakeTimers();
    try {
      const { video, callbacks } = controlledVideo();
      const worker = new FakeWorker();
      const controller = new VisionController({ camera: fakeCamera(video) as unknown as CameraController, createWorker: () => worker, baseUrl: "/", createBitmap: () => Promise.resolve({ width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap) });
      await controller.start({ video });
      const ready = controller.waitForFirstResult();
      controller.setSuspended(true);
      await vi.advanceTimersByTimeAsync(25_000);
      controller.setSuspended(false);
      const timestamp = performance.now();
      callbacks.at(-1)?.(timestamp, {} as VideoFrameCallbackMetadata);
      await Promise.resolve();
      worker.emit({ type: "RESULT", provider: "wasm", result: emptyVisionResult(0, timestamp) });
      await expect(ready).resolves.toBeUndefined();
      await controller.stop();
    } finally { vi.useRealTimers(); }
  });

  it("ignores unrelated result IDs without releasing a real in-flight frame", async () => {
    const { video, callbacks } = controlledVideo();
    const worker = new FakeWorker();
    const controller = new VisionController({ camera: fakeCamera(video) as unknown as CameraController, createWorker: () => worker, baseUrl: "/", createBitmap: () => Promise.resolve({ width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap) });
    const listener = vi.fn<(event: VisionControllerEvent) => void>();
    controller.subscribe(listener);
    await controller.start({ video });
    callbacks[0]?.(100, {} as VideoFrameCallbackMetadata);
    await Promise.resolve();
    worker.emit({ type: "RESULT", provider: "wasm", result: emptyVisionResult(999, 100) });
    expect(listener.mock.calls.filter(([event]) => event.type === "result")).toHaveLength(0);
    callbacks[1]?.(300, {} as VideoFrameCallbackMetadata);
    await Promise.resolve();
    expect(worker.messages.filter((message) => message.type === "FRAME")).toHaveLength(1);
    await controller.stop();
  });

  it("pauses an in-flight watchdog in the background and rearms it only on return", async () => {
    vi.useFakeTimers();
    try {
      const { video, callbacks } = controlledVideo();
      const worker = new FakeWorker();
      const camera = fakeCamera(video);
      const controller = new VisionController({ camera: camera as unknown as CameraController, createWorker: () => worker, baseUrl: "/", createBitmap: () => Promise.resolve({ width: 640, height: 360, close: vi.fn() }) });
      const listener = vi.fn<(event: VisionControllerEvent) => void>();
      controller.subscribe(listener);
      await controller.start({ video });
      callbacks[0]?.(100, {} as VideoFrameCallbackMetadata);
      await Promise.resolve();
      controller.setSuspended(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(camera.active).toBe(true);
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(listener.mock.calls.some(([event]) => event.type === "error")).toBe(false);
      controller.setSuspended(false);
      await vi.advanceTimersByTimeAsync(20_100);
      expect(listener.mock.calls.some(([event]) => event.type === "error" && !event.recoverable)).toBe(true);
      await controller.stop();
    } finally { vi.useRealTimers(); }
  });

  it("excludes a hidden period even when background timers never fire", async () => {
    vi.useFakeTimers();
    try {
      let now = 100;
      const { video, callbacks } = controlledVideo();
      const worker = new FakeWorker();
      const controller = new VisionController({ camera: fakeCamera(video) as unknown as CameraController, createWorker: () => worker, baseUrl: "/", now: () => now, createBitmap: () => Promise.resolve({ width: 640, height: 360, close: vi.fn() }) });
      await controller.start({ video });
      const ready = controller.waitForFirstResult();
      controller.setSuspended(true);
      now += 30_000;
      controller.setSuspended(false);
      await vi.advanceTimersByTimeAsync(100);
      callbacks.at(-1)?.(now, {} as VideoFrameCallbackMetadata);
      await Promise.resolve();
      worker.emit({ type: "RESULT", provider: "wasm", result: emptyVisionResult(0, now) });
      await expect(ready).resolves.toBeUndefined();
      await controller.stop();
    } finally { vi.useRealTimers(); }
  });

  it.each(["reset", "options"] as const)("ignores a queued result/error after %s without breaking the frame loop", async (operation) => {
    const { video, callbacks } = controlledVideo();
    const worker = new FakeWorker();
    const controller = new VisionController({ camera: fakeCamera(video) as unknown as CameraController, createWorker: () => worker, baseUrl: "/", createBitmap: () => Promise.resolve({ width: 640, height: 360, close: vi.fn() }) });
    const listener = vi.fn<(event: VisionControllerEvent) => void>();
    controller.subscribe(listener);
    await controller.start({ video });
    callbacks[0]?.(100, {} as VideoFrameCallbackMetadata);
    await Promise.resolve();
    if (operation === "reset") controller.reset();
    else controller.updateOptions({ switchConfirmationMs: 150 });
    worker.emit({ type: "RESULT", provider: "wasm", result: emptyVisionResult(0, 100) });
    worker.emit({ type: "ERROR", message: "old failure", recoverable: true, frameId: 0 });
    expect(listener.mock.calls.some(([event]) => event.type === "result" || event.type === "error")).toBe(false);
    callbacks.at(-1)?.(200, {} as VideoFrameCallbackMetadata);
    await Promise.resolve();
    worker.emit({ type: "RESULT", provider: "wasm", result: emptyVisionResult(1, 200) });
    expect(listener.mock.calls.filter(([event]) => event.type === "result")).toHaveLength(1);
    await controller.stop();
  });

  it("reports recoverable errors and stops after repeated failures", async () => {
    const video = document.createElement("video");
    const worker = new FakeWorker();
    const camera = fakeCamera(video);
    const controller = new VisionController({ camera: camera as unknown as CameraController, createWorker: () => worker, baseUrl: "/" });
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.start({ video });
    worker.emit({ type: "ERROR", message: "GPU failed", recoverable: true });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "error", recoverable: true }));
    for (let index = 0; index < 4; index++) worker.emit({ type: "ERROR", message: "GPU failed", recoverable: true });
    await controller.stop();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "error", recoverable: false }));
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a worker that never completes an in-flight frame", async () => {
    vi.useFakeTimers();
    try {
      const video = document.createElement("video");
      Object.defineProperty(video, "readyState", { value: HTMLMediaElement.HAVE_CURRENT_DATA });
      const worker = new FakeWorker();
      const camera = fakeCamera(video);
      const controller = new VisionController({ camera: camera as unknown as CameraController, createWorker: () => worker, baseUrl: "/", createBitmap: () => Promise.resolve({ width: 1280, height: 720, close: vi.fn() } as unknown as ImageBitmap), now: () => performance.now() });
      const listener = vi.fn();
      controller.subscribe(listener);
      await controller.start({ video });
      await vi.advanceTimersByTimeAsync(20_100);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "error", recoverable: false }));
      await controller.stop();
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("never posts a pending bitmap after STOP", async () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_CURRENT_DATA,
    });
    const frameCallbacks: VideoFrameRequestCallback[] = [];
    Object.defineProperty(video, "requestVideoFrameCallback", {
      configurable: true,
      value: vi.fn((callback: VideoFrameRequestCallback) => {
        frameCallbacks.push(callback);
        return 1;
      }),
    });
    Object.defineProperty(video, "cancelVideoFrameCallback", {
      configurable: true,
      value: vi.fn(),
    });

    const worker = new FakeWorker();
    const camera = fakeCamera(video);
    const bitmapResolvers: ((bitmap: ImageBitmap) => void)[] = [];
    const createBitmap = vi.fn(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          bitmapResolvers.push(resolve);
        }),
    );
    const controller = new VisionController({
      camera: camera as unknown as CameraController,
      createWorker: () => worker,
      createBitmap,
      baseUrl: "/",
      now: () => 100,
    });

    await controller.start({ video });
    expect(frameCallbacks[0]).toBeDefined();
    frameCallbacks[0]?.(100, {} as VideoFrameCallbackMetadata);
    await Promise.resolve();
    expect(createBitmap).toHaveBeenCalledOnce();

    const stopping = controller.stop();
    const close = vi.fn();
    bitmapResolvers[0]?.({ width: 1280, height: 720, close });
    await stopping;
    await Promise.resolve();

    expect(worker.messages.map((message) => message.type)).toEqual([
      "INIT",
      "STOP",
    ]);
    expect(close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(camera.stop).toHaveBeenCalled();
  });
});
