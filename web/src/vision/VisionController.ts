import { CameraController } from "./CameraController";
import {
  DEFAULT_AI_FPS,
  DEFAULT_CAMERA_HEIGHT,
  DEFAULT_CAMERA_WIDTH,
  MAX_AI_FPS,
  MIN_AI_FPS,
  clamp,
  createVisionAssetUrls,
  type CameraDevice,
  type CameraInfo,
  type VisionControllerEvent,
  type VisionExecutionProvider,
  type VisionListener,
  type VisionStartOptions,
} from "./types";
import {
  parseWorkerResponse,
  SingleFrameBackpressure,
  type VisionWorkerRequest,
  type WorkerInferenceOptions,
} from "./workerProtocol";

interface WorkerLike {
  postMessage(message: VisionWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  terminate(): void;
}

export interface VisionControllerDependencies {
  readonly camera?: CameraController;
  readonly createWorker?: () => WorkerLike;
  readonly createBitmap?: (
    video: HTMLVideoElement,
  ) => Promise<ImageBitmap | ImageData>;
  readonly baseUrl?: string;
  readonly now?: () => number;
}

interface CaptureContext {
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
}

type CaptureCanvas = OffscreenCanvas | HTMLCanvasElement;
export type CaptureCanvasFactory = (
  width: number,
  height: number,
) => CaptureCanvas;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  let rejectPromise: ((reason: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T): void => {
      resolvePromise?.(value);
    },
    reject: (reason: unknown): void => {
      rejectPromise?.(reason);
    },
  };
}

function defaultWorkerFactory(): WorkerLike {
  // The worker source imports the local vision pipeline as ES modules. Keep the
  // browser worker and MediaPipe's module-specific WASM loader on the same ESM
  // path in both Vite development and production builds.
  return new Worker(new URL("./emotion.worker.ts", import.meta.url), {
    name: "emotion-runner-vision",
    type: "module",
  });
}

function defaultCaptureCanvasFactory(
  width: number,
  height: number,
): CaptureCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("カメラ映像を取得するCanvasを作成できません。");
}

export async function captureVideoFrame(
  video: HTMLVideoElement,
  bitmapFactory:
    | ((source: HTMLVideoElement) => Promise<ImageBitmap>)
    | null
    | undefined = undefined,
  canvasFactory: CaptureCanvasFactory = defaultCaptureCanvasFactory,
): Promise<ImageBitmap | ImageData> {
  const availableBitmapFactory =
    bitmapFactory === undefined
      ? typeof createImageBitmap === "function"
        ? (source: HTMLVideoElement): Promise<ImageBitmap> =>
            createImageBitmap(source)
        : null
      : bitmapFactory;
  if (availableBitmapFactory !== null) {
    return availableBitmapFactory(video);
  }

  const width = video.videoWidth || DEFAULT_CAMERA_WIDTH;
  const height = video.videoHeight || DEFAULT_CAMERA_HEIGHT;
  const canvas = canvasFactory(width, height);
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  }) as CaptureContext | null;
  if (context === null) {
    throw new Error("カメラ映像の2D Canvasを初期化できません。");
  }
  context.drawImage(video, 0, 0);
  return context.getImageData(0, 0, width, height);
}

function closeCapturedFrame(frame: ImageBitmap | ImageData): void {
  if (capturedFrameIsBitmap(frame)) {
    frame.close();
  }
}

function capturedFrameIsBitmap(
  frame: ImageBitmap | ImageData,
): frame is ImageBitmap {
  return "close" in frame && typeof frame.close === "function";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AdaptiveFrameRate {
  private target: number;

  public constructor(initialFps = DEFAULT_AI_FPS) {
    this.target = clamp(initialFps, MIN_AI_FPS, MAX_AI_FPS);
  }

  public get fps(): number {
    return this.target;
  }

  public get intervalMs(): number {
    return 1000 / this.target;
  }

  public observe(inferenceMs: number): number {
    if (!Number.isFinite(inferenceMs) || inferenceMs <= 0) {
      return this.target;
    }
    const sustainableFps = clamp(
      1000 / (inferenceMs * 1.35 + 4),
      MIN_AI_FPS,
      MAX_AI_FPS,
    );
    this.target = 0.75 * this.target + 0.25 * sustainableFps;
    return this.target;
  }

  public reset(initialFps = DEFAULT_AI_FPS): void {
    this.target = clamp(initialFps, MIN_AI_FPS, MAX_AI_FPS);
  }
}

export class VisionController {
  private readonly camera: CameraController;
  private readonly createWorker: () => WorkerLike;
  private readonly createBitmap: (
    video: HTMLVideoElement,
  ) => Promise<ImageBitmap | ImageData>;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly listeners = new Set<VisionListener>();
  private readonly backpressure = new SingleFrameBackpressure();
  private readonly adaptiveFrameRate = new AdaptiveFrameRate();
  private worker: WorkerLike | null = null;
  private video: HTMLVideoElement | null = null;
  private provider: VisionExecutionProvider | null = null;
  private readyDeferred: Deferred<VisionExecutionProvider> | null = null;
  private stoppedDeferred: Deferred<void> | null = null;
  private running = false;
  private generation = 0;
  private nextFrameId = 0;
  private lastSubmittedAt = Number.NEGATIVE_INFINITY;
  private lastResultAt: number | null = null;
  private smoothedActualFps = 0;
  private videoFrameCallbackId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private stopPromise: Promise<void> | null = null;

  public constructor(dependencies: VisionControllerDependencies = {}) {
    this.camera = dependencies.camera ?? new CameraController();
    this.createWorker = dependencies.createWorker ?? defaultWorkerFactory;
    this.createBitmap = dependencies.createBitmap ?? captureVideoFrame;
    this.baseUrl = dependencies.baseUrl ?? import.meta.env.BASE_URL;
    this.now = dependencies.now ?? (() => performance.now());
  }

  public subscribe(listener: VisionListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public get executionProvider(): VisionExecutionProvider | null {
    return this.provider;
  }

  public async getDevices(): Promise<readonly CameraDevice[]> {
    return this.camera.getDevices();
  }

  public async start(options: VisionStartOptions): Promise<CameraInfo> {
    await this.stop();
    const generation = ++this.generation;
    this.emitStatus("requesting-camera", "カメラの許可を確認しています…");
    this.video = options.video;
    this.adaptiveFrameRate.reset(options.initialAiFps);
    this.nextFrameId = 0;
    this.lastSubmittedAt = Number.NEGATIVE_INFINITY;
    this.lastResultAt = null;
    this.smoothedActualFps = 0;

    try {
      const cameraInfo = await this.camera.start(options);
      if (generation !== this.generation) {
        throw new Error("Camera start was superseded");
      }
      const worker = this.createWorker();
      this.worker = worker;
      worker.addEventListener("message", (event) => {
        this.handleWorkerMessage(event.data);
      });
      worker.addEventListener("error", (event) => {
        this.handleWorkerError(event);
      });

      const ready = createDeferred<VisionExecutionProvider>();
      this.readyDeferred = ready;
      worker.postMessage({
        type: "INIT",
        assets: createVisionAssetUrls(this.baseUrl),
      });
      this.emitStatus("loading-models", "AIモデルを読み込んでいます…");
      await this.withTimeout(ready.promise, 30_000, "AIモデルの読み込みがタイムアウトしました。");
      if (generation !== this.generation) {
        throw new Error("Vision start was superseded");
      }
      this.readyDeferred = null;
      this.running = true;
      this.emitStatus("running", "表情認識を実行中");
      this.scheduleNextFrame();
      return cameraInfo;
    } catch (error) {
      await this.stop();
      this.emitError(errorMessage(error), false);
      throw error;
    }
  }

  public reset(): void {
    this.worker?.postMessage({ type: "RESET" });
    this.lastResultAt = null;
    this.smoothedActualFps = 0;
  }

  public updateOptions(options: WorkerInferenceOptions): void {
    this.worker?.postMessage({ type: "UPDATE_OPTIONS", options });
  }

  public stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    this.stopPromise = this.performStop().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    const hadResources = this.worker !== null || this.camera.active || this.running;
    if (hadResources) {
      this.emitStatus("stopping", "カメラとAIを停止しています…");
    }
    this.running = false;
    this.generation += 1;
    this.cancelFrameLoop();
    this.backpressure.reset();
    this.readyDeferred?.reject(new Error("Vision controller stopped"));
    this.readyDeferred = null;

    // Stop the privacy-sensitive camera track before waiting for a Worker that
    // may need the full shutdown timeout. CameraController.stop() is synchronous.
    this.camera.stop();
    this.video = null;

    const worker = this.worker;
    this.worker = null;
    if (worker !== null) {
      const stopped = createDeferred<void>();
      this.stoppedDeferred = stopped;
      try {
        worker.postMessage({ type: "STOP" });
        await this.withTimeout(stopped.promise, 3_000, "Vision worker stop timeout");
      } catch {
        // terminate() below is the final cleanup path for an unresponsive worker.
      } finally {
        this.stoppedDeferred = null;
        worker.terminate();
      }
    }
    this.provider = null;
    this.lastResultAt = null;
    this.smoothedActualFps = 0;
    if (hadResources) {
      this.emitStatus("stopped", "カメラを停止しました");
    }
  }

  private handleWorkerMessage(value: unknown): void {
    let response;
    try {
      response = parseWorkerResponse(value);
    } catch (error) {
      this.emitError(errorMessage(error), false);
      this.readyDeferred?.reject(error);
      return;
    }

    switch (response.type) {
      case "INITIALIZING":
        this.emitStatus("loading-models", response.message);
        break;
      case "STATUS":
        this.emitStatus(
          response.status === "loading-models" ? "loading-models" : "stopping",
          response.message,
        );
        break;
      case "READY":
        this.provider = response.provider;
        this.readyDeferred?.resolve(response.provider);
        break;
      case "RESULT": {
        this.backpressure.complete(response.result.frameId);
        const completedAt = this.now();
        if (this.lastResultAt !== null) {
          const elapsed = completedAt - this.lastResultAt;
          if (elapsed > 0) {
            const instantFps = 1000 / elapsed;
            this.smoothedActualFps =
              this.smoothedActualFps <= 0
                ? instantFps
                : 0.15 * instantFps + 0.85 * this.smoothedActualFps;
          }
        }
        this.lastResultAt = completedAt;
        this.emit({
          type: "result",
          provider: response.provider,
          result: {
            ...response.result,
            aiFps: this.smoothedActualFps || response.result.aiFps,
          },
        });
        break;
      }
      case "METRICS":
        this.adaptiveFrameRate.observe(response.inferenceMs);
        break;
      case "WARNING":
        if (response.frameId !== undefined) {
          this.backpressure.complete(response.frameId);
        }
        break;
      case "ERROR":
        if (response.frameId !== undefined) {
          this.backpressure.complete(response.frameId);
        }
        if (response.recoverable) {
          break;
        }
        this.emitError(response.message, false);
        this.readyDeferred?.reject(new Error(response.message));
        break;
      case "STOPPED":
        this.stoppedDeferred?.resolve();
        break;
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    const message = event.message || "Vision worker failed";
    this.emitError(message, false);
    this.readyDeferred?.reject(new Error(message));
  }

  private scheduleNextFrame(): void {
    const video = this.video;
    if (!this.running || video === null) {
      return;
    }
    if (typeof video.requestVideoFrameCallback === "function") {
      this.videoFrameCallbackId = video.requestVideoFrameCallback((now) => {
        this.videoFrameCallbackId = null;
        this.scheduleNextFrame();
        void this.maybeSubmitFrame(now);
      });
      return;
    }
    const pollInterval = Math.max(16, this.adaptiveFrameRate.intervalMs / 2);
    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.scheduleNextFrame();
      void this.maybeSubmitFrame(this.now());
    }, pollInterval);
  }

  private cancelFrameLoop(): void {
    if (this.videoFrameCallbackId !== null && this.video !== null) {
      this.video.cancelVideoFrameCallback(this.videoFrameCallbackId);
    }
    this.videoFrameCallbackId = null;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private async maybeSubmitFrame(timestampMs: number): Promise<void> {
    const video = this.video;
    const worker = this.worker;
    if (
      !this.running ||
      video === null ||
      worker === null ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      timestampMs - this.lastSubmittedAt < this.adaptiveFrameRate.intervalMs
    ) {
      return;
    }
    const frameId = this.nextFrameId;
    if (!this.backpressure.acquire(frameId)) {
      return;
    }
    this.nextFrameId += 1;
    const generation = this.generation;
    let frame: ImageBitmap | ImageData | null = null;
    try {
      frame = await this.createBitmap(video);
      if (
        !this.running ||
        generation !== this.generation ||
        worker !== this.worker
      ) {
        closeCapturedFrame(frame);
        this.backpressure.complete(frameId);
        return;
      }
      this.lastSubmittedAt = timestampMs;
      if (capturedFrameIsBitmap(frame)) {
        worker.postMessage(
          { type: "FRAME", frameId, timestampMs, bitmap: frame },
          [frame],
        );
      } else {
        const buffer = frame.data.buffer;
        worker.postMessage(
          { type: "FRAME", frameId, timestampMs, imageData: frame },
          buffer instanceof ArrayBuffer ? [buffer] : [],
        );
      }
      frame = null;
    } catch (error) {
      if (frame !== null) {
        closeCapturedFrame(frame);
      }
      this.backpressure.complete(frameId);
      this.emitError(errorMessage(error), true);
    }
  }

  private emit(event: VisionControllerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private emitStatus(
    status: Extract<VisionControllerEvent, { type: "status" }>["status"],
    message: string,
  ): void {
    this.emit({ type: "status", status, message });
  }

  private emitError(message: string, recoverable: boolean): void {
    this.emit({ type: "error", message, recoverable });
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }
}
