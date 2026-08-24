import { describe, expect, it, vi } from "vitest";

import { CameraController } from "./CameraController";
import {
  AdaptiveFrameRate,
  captureVideoFrame,
  VisionController,
} from "./VisionController";
import type { CameraInfo } from "./types";
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

  private emit(message: VisionWorkerResponse): void {
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
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 640, 360);
    expect(captured).toBe(expected);
  });
});

describe("VisionController lifecycle", () => {
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
