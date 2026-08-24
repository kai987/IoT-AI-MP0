import { describe, expect, it, vi } from "vitest";

import { CameraController } from "./CameraController";

describe("CameraController", () => {
  it("opens the requested device at the default ideal capture settings", async () => {
    const track = {
      label: "Built-in Camera",
      getSettings: vi.fn(() => ({
        deviceId: "built-in",
        width: 1280,
        height: 720,
        frameRate: 30,
      })),
      stop: vi.fn(),
    };
    const stream = {
      getVideoTracks: vi.fn(() => [track]),
      getTracks: vi.fn(() => [track]),
    };
    const enumerateDevices = vi.fn().mockResolvedValue([
      {
        kind: "videoinput",
        deviceId: "built-in",
        groupId: "local",
        label: "Built-in Camera",
      },
    ]);
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const controller = new CameraController({
      enumerateDevices,
      getUserMedia,
    } as unknown as MediaDevices);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);

    const info = await controller.start({ video, deviceId: "built-in" });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        deviceId: { exact: "built-in" },
      },
    });
    expect(info).toMatchObject({
      deviceId: "built-in",
      label: "Built-in Camera",
      width: 1280,
      height: 720,
      frameRate: 30,
    });
    expect(video.srcObject).toBe(stream);

    controller.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(controller.active).toBe(false);
  });

  it("uses the user-facing camera when no device id is supplied", async () => {
    const track = {
      label: "Camera",
      getSettings: () => ({}),
      stop: vi.fn(),
    };
    const mediaStream = {
      getVideoTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(
      (constraints: MediaStreamConstraints): Promise<MediaStream> => {
        void constraints;
        return Promise.resolve(mediaStream);
      },
    );
    const controller = new CameraController({
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia,
    } as unknown as MediaDevices);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    vi.spyOn(video, "pause").mockImplementation(() => undefined);

    await controller.start({ video });
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: { ideal: "user" },
      },
    });
    controller.stop();
  });
});
