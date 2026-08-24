import {
  EMOTION_INPUT_DIMS,
  prepareEmotionInput,
  softmax,
} from "./preprocessing";
import type { VisionExecutionProvider } from "./types";

export interface OrtTensorLike {
  readonly data?: unknown;
  getData?: () => Promise<unknown>;
}

export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly outputMetadata?: readonly {
    readonly shape?: readonly (number | string)[];
  }[];
  run(feeds: Readonly<Record<string, OrtTensorLike>>): Promise<
    Readonly<Record<string, OrtTensorLike>>
  >;
  release(): Promise<void>;
}

export interface OrtRuntimeLike {
  readonly env: {
    readonly wasm: {
      wasmPaths?:
        | string
        | Readonly<{
            mjs?: string;
            wasm?: string;
          }>;
      numThreads?: number;
      proxy?: boolean;
    };
  };
  readonly Tensor: new (
    type: "float32",
    data: Float32Array,
    dimensions: readonly number[],
  ) => OrtTensorLike;
  readonly InferenceSession: {
    create(
      modelUrl: string,
      options: Readonly<Record<string, unknown>>,
    ): Promise<OrtSessionLike>;
  };
}

export interface EmotionClassifierOptions {
  readonly modelUrl: string;
  readonly ortWasmRoot: string;
  readonly ort?: OrtRuntimeLike;
  readonly webGpuAvailable?: boolean;
}

type OrtModule = typeof import("onnxruntime-web/webgpu");

async function loadOrtRuntime(webGpu: boolean): Promise<OrtRuntimeLike> {
  const module: OrtModule = webGpu
    ? await import("onnxruntime-web/webgpu")
    : await import("onnxruntime-web/wasm");
  return module as unknown as OrtRuntimeLike;
}

function canDecompressGzip(): boolean {
  return typeof DecompressionStream !== "undefined";
}

async function prepareWebGpuWasmPaths(
  ort: OrtRuntimeLike,
  wasmRoot: string,
): Promise<void> {
  const compressedWasmUrl = new URL(
    "ort-wasm-simd-threaded.jsep.wasm.gzip",
    wasmRoot,
  ).href;
  const response = await fetch(compressedWasmUrl);
  if (!response.ok || response.body === null) {
    throw new Error(
      `Compressed ONNX Runtime WebGPU binary could not be loaded (${response.status})`,
    );
  }
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const wasmBuffer = await new Response(stream).arrayBuffer();
  const wasmUrl = URL.createObjectURL(
    new Blob([wasmBuffer], { type: "application/wasm" }),
  );
  ort.env.wasm.wasmPaths = {
    mjs: new URL("ort-wasm-simd-threaded.jsep.mjs", wasmRoot).href,
    wasm: wasmUrl,
  };
}

function currentLocationHref(): string {
  if (typeof location !== "undefined" && location.href.length > 0) {
    return location.href;
  }
  throw new Error("A browser location is required to resolve vision assets");
}

export function resolveLocalAssetUrl(
  assetUrl: string,
  documentUrl = currentLocationHref(),
): string {
  const resolved = new URL(assetUrl, documentUrl);
  const documentOrigin = new URL(documentUrl).origin;
  if (resolved.origin !== documentOrigin) {
    throw new Error(`Cross-origin vision assets are not allowed: ${assetUrl}`);
  }
  return resolved.href;
}

function browserHasWebGpu(): boolean {
  return typeof navigator !== "undefined" && Reflect.has(navigator, "gpu");
}

function validateSessionContract(session: OrtSessionLike): void {
  if (session.inputNames.length !== 1) {
    throw new Error("Emotion model must expose exactly one input tensor");
  }
  if (session.outputNames.length < 1) {
    throw new Error("Emotion model must expose at least one output tensor");
  }
  const shape = session.outputMetadata?.[0]?.shape;
  if (shape !== undefined && shape.every((dimension) => typeof dimension === "number")) {
    const elementCount = shape.reduce<number>(
      (product, dimension) => product * Number(dimension),
      1,
    );
    if (elementCount !== 8) {
      throw new Error("Emotion model output metadata is not eight-class");
    }
  }
}

function toNumericScores(value: unknown): readonly number[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("length" in value) ||
    typeof value.length !== "number"
  ) {
    throw new TypeError("Emotion model output is not an array-like tensor");
  }
  const scores: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = Reflect.get(value, index);
    if (typeof entry !== "number") {
      throw new TypeError("Emotion model output contains a non-number");
    }
    scores.push(entry);
  }
  return scores;
}

export class EmotionClassifier {
  public provider: VisionExecutionProvider;
  public fallbackReason: string | null;
  private readonly ort: OrtRuntimeLike;
  private readonly modelUrl: string;
  private session: OrtSessionLike;
  private fallbackPromise: Promise<void> | null = null;
  private closed = false;

  private constructor(
    ort: OrtRuntimeLike,
    session: OrtSessionLike,
    provider: VisionExecutionProvider,
    fallbackReason: string | null,
    modelUrl: string,
  ) {
    this.ort = ort;
    this.session = session;
    this.provider = provider;
    this.fallbackReason = fallbackReason;
    this.modelUrl = modelUrl;
  }

  public static async create(
    options: EmotionClassifierOptions,
  ): Promise<EmotionClassifier> {
    const documentUrl = currentLocationHref();
    const modelUrl = resolveLocalAssetUrl(options.modelUrl, documentUrl);
    const wasmRoot = resolveLocalAssetUrl(options.ortWasmRoot, documentUrl);
    const normalizedWasmRoot = wasmRoot.endsWith("/")
      ? wasmRoot
      : `${wasmRoot}/`;
    const requestedWebGpu = options.webGpuAvailable ?? browserHasWebGpu();
    const bundledRuntime = options.ort === undefined;
    const mayUseWebGpu =
      requestedWebGpu && (!bundledRuntime || canDecompressGzip());
    const ort = options.ort ?? (await loadOrtRuntime(mayUseWebGpu));
    if (bundledRuntime && mayUseWebGpu) {
      await prepareWebGpuWasmPaths(ort, normalizedWasmRoot);
    } else {
      ort.env.wasm.wasmPaths = normalizedWasmRoot;
    }
    const hardwareConcurrency =
      typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency || 1;
    ort.env.wasm.numThreads =
      typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
        ? Math.min(4, hardwareConcurrency)
        : 1;
    ort.env.wasm.proxy = false;

    let fallbackReason: string | null =
      requestedWebGpu && !mayUseWebGpu
        ? "WebGPU runtime compression is unsupported; using WASM"
        : null;
    if (mayUseWebGpu) {
      try {
        const webGpuSession = await ort.InferenceSession.create(modelUrl, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
        validateSessionContract(webGpuSession);
        return new EmotionClassifier(
          ort,
          webGpuSession,
          "webgpu",
          null,
          modelUrl,
        );
      } catch (error) {
        fallbackReason =
          error instanceof Error ? error.message : "WebGPU initialization failed";
      }
    }

    const wasmSession = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    validateSessionContract(wasmSession);
    return new EmotionClassifier(
      ort,
      wasmSession,
      "wasm",
      fallbackReason,
      modelUrl,
    );
  }

  public async classify(imageData: ImageData): Promise<readonly number[]> {
    if (this.closed) {
      throw new Error("Emotion classifier is closed");
    }
    try {
      return await this.runSession(imageData);
    } catch (error) {
      if (this.provider !== "webgpu" || this.closed) {
        throw error;
      }
      await this.fallbackToWasm(error);
      return this.runSession(imageData);
    }
  }

  private async runSession(imageData: ImageData): Promise<readonly number[]> {
    const session = this.session;
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (inputName === undefined || outputName === undefined) {
      throw new Error("Emotion model tensor names are unavailable");
    }
    const input = new this.ort.Tensor(
      "float32",
      prepareEmotionInput(imageData),
      EMOTION_INPUT_DIMS,
    );
    const outputs = await session.run({ [inputName]: input });
    const output = outputs[outputName];
    if (output === undefined) {
      throw new Error(`Emotion model did not return output ${outputName}`);
    }
    const outputData =
      typeof output.getData === "function"
        ? await output.getData()
        : output.data;
    return softmax(toNumericScores(outputData));
  }

  private async fallbackToWasm(error: unknown): Promise<void> {
    if (this.provider === "wasm") {
      return;
    }
    if (this.fallbackPromise !== null) {
      return this.fallbackPromise;
    }
    const failedSession = this.session;
    this.fallbackPromise = (async (): Promise<void> => {
      const wasmSession = await this.ort.InferenceSession.create(this.modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      validateSessionContract(wasmSession);
      this.session = wasmSession;
      this.provider = "wasm";
      this.fallbackReason = `WebGPU inference failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      try {
        await failedSession.release();
      } catch {
        // A device-lost WebGPU session can also reject during release.
      }
    })();
    try {
      await this.fallbackPromise;
    } finally {
      this.fallbackPromise = null;
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.session.release();
  }
}
