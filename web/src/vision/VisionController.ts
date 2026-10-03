import { CameraController } from "./CameraController";
import { LatencyTracker } from "./LatencyTracker";
import { VISION_HEALTH } from "../RuntimeSettings";
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
  drawImage(image: CanvasImageSource, dx: number, dy: number, width?: number, height?: number): void;
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
  maxWidth = DEFAULT_CAMERA_WIDTH,
): Promise<ImageBitmap | ImageData> {
  const sourceWidth = video.videoWidth || DEFAULT_CAMERA_WIDTH;
  const sourceHeight = video.videoHeight || DEFAULT_CAMERA_HEIGHT;
  const width = Math.min(sourceWidth, maxWidth);
  const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
  const availableBitmapFactory =
    bitmapFactory === undefined
      ? typeof createImageBitmap === "function"
        ? (source: HTMLVideoElement): Promise<ImageBitmap> =>
            createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: "low" })
        : null
      : bitmapFactory;
  if (availableBitmapFactory !== null) {
    try { return await availableBitmapFactory(video); } catch { /* Canvasに代替 / 某些浏览器需要Canvas采集。 */ }
  }

  const canvas = canvasFactory(width, height);
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  }) as CaptureContext | null;
  if (context === null) {
    throw new Error("カメラ映像の2D Canvasを初期化できません。");
  }
  context.drawImage(video, 0, 0, width, height);
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
  private maximum = MAX_AI_FPS;

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
      this.maximum,
    );
    this.target = 0.75 * this.target + 0.25 * sustainableFps;
    return this.target;
  }

  public reset(initialFps = DEFAULT_AI_FPS, maximum = MAX_AI_FPS): void {
    this.maximum = clamp(maximum, MIN_AI_FPS, MAX_AI_FPS);
    this.target = clamp(initialFps, MIN_AI_FPS, this.maximum);
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
  private readonly latencyTracker = new LatencyTracker();
  private worker: WorkerLike | null = null;
  private video: HTMLVideoElement | null = null;
  private provider: VisionExecutionProvider | null = null;
  private readyDeferred: Deferred<VisionExecutionProvider> | null = null;
  private stoppedDeferred: Deferred<void> | null = null;
  private running = false;
  private suspended = false;
  private suspensionStartedAt: number | null = null;
  private totalSuspendedMs = 0;
  private inferenceEpoch = 0;
  private pendingCapture: { frameId: number; epoch: number; startedAt: number; captureMs: number; timeoutRemainingMs: number; deadlineAt: number | null } | null = null;
  private generation = 0;
  private nextFrameId = 0;
  private lastSubmittedAt = Number.NEGATIVE_INFINITY;
  private lastResultAt: number | null = null;
  private smoothedActualFps = 0;
  private videoFrameCallbackId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private stopPromise: Promise<void> | null = null;
  private frameTimeout: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;
  private analyzeEvery = 1;
  private captureFrameCount = 0;
  private lastCameraFrameAt = 0;
  private cameraFps = 0;
  private analysisWidth = 640;
  private firstResult: Deferred<void> | null = null;
  private hasCompletedFrame = false;

  public constructor(dependencies: VisionControllerDependencies = {}) {
    this.camera = dependencies.camera ?? new CameraController();
    this.createWorker = dependencies.createWorker ?? defaultWorkerFactory;
    // Canvasフォールバックを再利用 / 位图不可用时复用采集Canvas，仅在尺寸变化时重新分配。
    let captureCanvas: CaptureCanvas | null = null;
    const reusableCanvasFactory: CaptureCanvasFactory = (width, height) => {
      captureCanvas ??= defaultCaptureCanvasFactory(width, height);
      if (captureCanvas.width !== width) captureCanvas.width = width;
      if (captureCanvas.height !== height) captureCanvas.height = height;
      return captureCanvas;
    };
    this.createBitmap = dependencies.createBitmap ?? ((video) => captureVideoFrame(video, undefined, reusableCanvasFactory, this.analysisWidth));
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
    this.adaptiveFrameRate.reset(options.initialAiFps, options.maxAiFps);
    this.analyzeEvery = Math.max(1, Math.trunc(options.analyzeEveryNFrames ?? 1));
    this.captureFrameCount = 0;
    this.lastCameraFrameAt = 0;
    this.cameraFps = 0;
    this.consecutiveErrors = 0;
    this.analysisWidth = Math.max(224, options.analysisWidth ?? 640);
    this.hasCompletedFrame = false;
    this.nextFrameId = 0;
    this.lastSubmittedAt = Number.NEGATIVE_INFINITY;
    this.lastResultAt = null;
    this.smoothedActualFps = 0;
    this.latencyTracker.reset();

    try {
      const cameraInfo = await this.camera.start(options);
      if (generation !== this.generation) {
        throw new Error("Camera start was superseded");
      }
      const worker = this.createWorker();
      this.worker = worker;
      worker.addEventListener("message", (event) => {
        if (worker === this.worker || (this.worker === null && this.stoppedDeferred !== null)) this.handleWorkerMessage(event.data);
      });
      worker.addEventListener("error", (event) => {
        if (worker === this.worker) this.handleWorkerError(event);
      });

      const ready = createDeferred<VisionExecutionProvider>();
      this.readyDeferred = ready;
      worker.postMessage({
        type: "INIT",
        assets: createVisionAssetUrls(this.baseUrl),
      });
      this.emitStatus("loading-models", "AIモデルを読み込んでいます…");
      await this.withTimeout(ready.promise, VISION_HEALTH.initializationTimeoutMs, "AIモデルの読み込みがタイムアウトしました。");
      if (generation !== this.generation) {
        throw new Error("Vision start was superseded");
      }
      this.readyDeferred = null;
      this.running = true;
      this.emitStatus("loading-models", "初回推論を準備しています…");
      this.scheduleNextFrame();
      return cameraInfo;
    } catch (error) {
      await this.stop();
      this.emitError(errorMessage(error), false);
      throw error;
    }
  }

  public reset(): void {
    this.invalidateHistory();
  }

  private invalidateHistory(options?: WorkerInferenceOptions): void {
    this.inferenceEpoch += 1;
    this.cancelFrameLoop();
    this.worker?.postMessage(options === undefined ? { type: "RESET" } : { type: "UPDATE_OPTIONS", options });
    this.lastResultAt = null;
    this.smoothedActualFps = 0;
    this.latencyTracker.reset();
    this.lastSubmittedAt = Number.NEGATIVE_INFINITY;
    this.lastCameraFrameAt = 0;
    this.cameraFps = 0;
    if (this.running && !this.suspended) this.scheduleNextFrame();
  }

  /** 背景では新規撮影・推論を止める / 后台暂停新帧采集与推理，保留已加载模型和摄像头连接。 */
  public setSuspended(suspended: boolean): void {
    if (suspended === this.suspended) return;
    const now = this.now();
    if (suspended) this.suspensionStartedAt = now;
    else if (this.suspensionStartedAt !== null) {
      this.totalSuspendedMs += Math.max(0, now - this.suspensionStartedAt);
      this.suspensionStartedAt = null;
    }
    const pending = this.pendingCapture;
    if (suspended && pending !== null && pending.deadlineAt !== null) {
      pending.timeoutRemainingMs = Math.max(1, pending.deadlineAt - now);
      pending.deadlineAt = null;
    }
    this.suspended = suspended;
    this.clearFrameTimeout();
    this.reset();
    if (!this.running) return;
    this.emitStatus(suspended ? "suspended" : "running",
      suspended ? "バックグラウンド中・AIを一時停止" : "新しい表情の取得を待っています");
    if (!suspended) this.armFrameTimeout();
  }

  /** 初回結果を待ってから開始 / 首次推理预热完成后再开始游戏，避免等待时掉血。 */
  public async waitForFirstResult(): Promise<void> {
    if (this.hasCompletedFrame) return;
    if (!this.running) throw new Error("カメラは停止しています。");
    this.firstResult ??= createDeferred<void>();
    await this.withActiveTimeout(this.firstResult.promise, VISION_HEALTH.warmupTimeoutMs, "初回推論がタイムアウトしました。省電力モードで再試行してください。");
    this.firstResult = null;
    if (!this.running) throw new Error("Vision warmup was superseded");
    this.emitStatus("running", "表情認識を実行中");
  }

  public updateOptions(options: WorkerInferenceOptions): void {
    this.invalidateHistory(options);
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
    this.clearFrameTimeout();
    this.backpressure.reset();
    this.pendingCapture = null;
    this.readyDeferred?.reject(new Error("Vision controller stopped"));
    this.readyDeferred = null;
    this.firstResult?.reject(new Error("Vision controller stopped"));
    this.firstResult = null;

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
        if (!this.running) break;
        const pending = this.pendingCapture;
        if (!this.backpressure.complete(response.result.frameId)) break;
        this.pendingCapture = null;
        this.clearFrameTimeout();
        if (this.suspended || pending?.epoch !== this.inferenceEpoch) break;
        this.consecutiveErrors = 0;
        this.hasCompletedFrame = true;
        this.firstResult?.resolve();
        const completedAt = this.now();
        const latencyMs = Math.max(0, completedAt - response.result.timestampMs);
        const latency = this.latencyTracker.observe(latencyMs);
        // 転送・撮影も予算に含める / 自适应预算纳入采集及传输耗时，不仅计算模型内部耗时。
        this.adaptiveFrameRate.observe(Math.max(response.result.inferenceMs, completedAt - pending.startedAt));
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
            latencyMs,
            captureMs: pending.captureMs,
            latencyP50Ms: latency.p50Ms,
            latencyP95Ms: latency.p95Ms,
            aiFps: this.smoothedActualFps || response.result.aiFps,
            cameraFps: this.cameraFps,
            analysisWidth: response.result.cameraWidth,
            analysisHeight: response.result.cameraHeight,
            cameraWidth: this.video?.videoWidth || response.result.cameraWidth,
            cameraHeight: this.video?.videoHeight || response.result.cameraHeight,
          },
        });
        break;
      }
      case "METRICS":
        // RESULTの往復時間で調整済み / 已使用RESULT端到端预算，避免同帧重复调整。
        break;
      case "WARNING":
        if (response.frameId !== undefined) {
          if (this.backpressure.complete(response.frameId)) {
            this.pendingCapture = null;
            this.clearFrameTimeout();
          }
        }
        break;
      case "ERROR": {
        const pending = this.pendingCapture;
        if (response.frameId !== undefined) {
          if (!this.backpressure.complete(response.frameId)) break;
          this.pendingCapture = null;
          this.clearFrameTimeout();
          if (this.suspended || pending?.epoch !== this.inferenceEpoch) break;
        }
        if (response.recoverable) {
          this.frameFailed(response.message);
          break;
        }
        this.emitError(response.message, false);
        this.readyDeferred?.reject(new Error(response.message));
        break;
      }
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
    if (!this.running || this.suspended || video === null) {
      return;
    }
    const epoch = this.inferenceEpoch;
    const generation = this.generation;
    if (typeof video.requestVideoFrameCallback === "function") {
      this.videoFrameCallbackId = video.requestVideoFrameCallback((now) => {
        if (!this.running || this.suspended || epoch !== this.inferenceEpoch || generation !== this.generation) return;
        if (this.lastCameraFrameAt > 0 && now > this.lastCameraFrameAt) {
          const fps = 1000 / (now - this.lastCameraFrameAt);
          this.cameraFps = this.cameraFps > 0 ? this.cameraFps * 0.8 + fps * 0.2 : fps;
        }
        this.lastCameraFrameAt = now;
        this.videoFrameCallbackId = null;
        this.scheduleNextFrame();
        this.captureFrameCount += 1;
        if (this.captureFrameCount % this.analyzeEvery === 0) {
          void this.maybeSubmitFrame(now);
        }
      });
      return;
    }
    const pollInterval = Math.max(16, this.adaptiveFrameRate.intervalMs / 2);
    this.timerId = setTimeout(() => {
      if (!this.running || this.suspended || epoch !== this.inferenceEpoch || generation !== this.generation) return;
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
      this.suspended ||
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
    const epoch = this.inferenceEpoch;
    this.pendingCapture = { frameId, epoch, startedAt: this.now(), captureMs: 0,
      timeoutRemainingMs: this.hasCompletedFrame ? VISION_HEALTH.frameTimeoutMs : VISION_HEALTH.warmupTimeoutMs, deadlineAt: null };
    this.armFrameTimeout();
    let frame: ImageBitmap | ImageData | null = null;
    try {
      frame = await this.createBitmap(video);
      if (
        !this.running ||
        this.suspended ||
        epoch !== this.inferenceEpoch ||
        generation !== this.generation ||
        worker !== this.worker
      ) {
        closeCapturedFrame(frame);
        if (generation === this.generation && worker === this.worker) {
          this.backpressure.complete(frameId);
          this.pendingCapture = null;
          this.clearFrameTimeout();
        }
        return;
      }
      if (this.pendingCapture !== null) this.pendingCapture.captureMs = Math.max(0, this.now() - this.pendingCapture.startedAt);
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
      if (generation !== this.generation || worker !== this.worker) return;
      this.backpressure.complete(frameId);
      this.pendingCapture = null;
      this.clearFrameTimeout();
      if (this.suspended || epoch !== this.inferenceEpoch) return;
      this.frameFailed(errorMessage(error));
    }
  }

  private clearFrameTimeout(): void {
    if (this.frameTimeout !== null) clearTimeout(this.frameTimeout);
    this.frameTimeout = null;
  }

  private armFrameTimeout(): void {
    const pending = this.pendingCapture;
    if (!this.running || this.suspended || pending === null) return;
    this.clearFrameTimeout();
    pending.deadlineAt = this.now() + pending.timeoutRemainingMs;
    this.frameTimeout = setTimeout(() => {
      this.frameTimeout = null;
      if (this.running && !this.suspended && this.pendingCapture === pending) {
        this.emitError("AIから応答がありません。カメラを再試行してください。", false);
        void this.stop();
      }
    }, pending.timeoutRemainingMs);
  }

  private frameFailed(message: string): void {
    this.consecutiveErrors += 1;
    const recoverable = this.consecutiveErrors < VISION_HEALTH.maxConsecutiveErrors;
    this.emitError(recoverable ? `推論を再試行中：${message}` : "AI推論が連続して失敗しました。カメラを再試行してください。", recoverable);
    if (!recoverable) void this.stop();
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

  private async withActiveTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    const startedAt = this.activeNow();
    let timer: ReturnType<typeof setInterval> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        if (this.activeNow() - startedAt >= timeoutMs) reject(new Error(message));
      }, 100);
    });
    try { return await Promise.race([promise, timeout]); }
    finally { if (timer !== null) clearInterval(timer); }
  }

  private activeNow(): number {
    const now = this.now();
    return now - this.totalSuspendedMs - (this.suspensionStartedAt === null ? 0 : Math.max(0, now - this.suspensionStartedAt));
  }
}
