import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { describe, expect, it, vi } from "vitest";

import {
  calculateLandmarkBounds,
  FaceLandmarkerRuntime,
  selectLargestFaceIndex,
  type FaceLandmarkerRuntimeOptions,
} from "./FaceLandmarkerRuntime";

function point(x: number, y: number): NormalizedLandmark {
  return { x, y, z: 0, visibility: 1 };
}

describe("FaceLandmarkerRuntime selection", () => {
  it("clamps normalized landmark bounds to the camera frame", () => {
    expect(
      calculateLandmarkBounds([point(-0.2, 0.1), point(0.8, 1.4)]),
    ).toEqual({ x: 0, y: 0.1, width: 0.8, height: 0.9 });
  });

  it("selects the largest valid face and ignores empty faces", () => {
    const faces = [
      [point(0.1, 0.1), point(0.2, 0.2)],
      [],
      [point(0.3, 0.2), point(0.9, 0.9)],
    ];
    expect(selectLargestFaceIndex(faces)).toBe(2);
    expect(selectLargestFaceIndex([[]])).toBeNull();
  });

  it("ignores non-finite landmarks", () => {
    expect(calculateLandmarkBounds([point(Number.NaN, 0.2)])).toBeNull();
  });

  it("uses MediaPipe's ES module WASM loader inside the module Worker", async () => {
    const fileset = {
      wasmLoaderPath: "/generated/mediapipe/vision_wasm_module_internal.js",
      wasmBinaryPath: "/generated/mediapipe/vision_wasm_module_internal.wasm",
    };
    const forVisionTasks = vi.fn(
      (basePath?: string, useModule?: boolean) => {
        void basePath;
        void useModule;
        return Promise.resolve(fileset);
      },
    );
    const close = vi.fn();
    const createFromOptions = vi.fn(
      (receivedFileset: unknown, receivedOptions: unknown) => {
        void receivedFileset;
        void receivedOptions;
        return Promise.resolve({ close });
      },
    );
    const mediaPipe = {
      FilesetResolver: { forVisionTasks },
      FaceLandmarker: { createFromOptions },
    } as unknown as NonNullable<FaceLandmarkerRuntimeOptions["mediaPipe"]>;

    const runtime = await FaceLandmarkerRuntime.create({
      modelUrl: "/generated/models/face_landmarker.task",
      wasmRoot: "/generated/mediapipe",
      mediaPipe,
      preferGpu: false,
    });

    expect(forVisionTasks).toHaveBeenCalledWith(
      new URL("/generated/mediapipe", window.location.href).href,
      true,
    );
    expect(createFromOptions).toHaveBeenCalledOnce();
    expect(createFromOptions.mock.calls[0]?.[1]).toMatchObject({
      baseOptions: { delegate: "CPU" },
      runningMode: "VIDEO",
    });

    runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
