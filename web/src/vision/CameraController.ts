import {
  DEFAULT_CAMERA_FRAME_RATE,
  DEFAULT_CAMERA_HEIGHT,
  DEFAULT_CAMERA_WIDTH,
  type CameraDevice,
  type CameraInfo,
  type CameraStartOptions,
} from "./types";

export class CameraControllerError extends Error {
  public readonly causeName: string;

  public constructor(message: string, causeName = "CameraError") {
    super(message);
    this.name = "CameraControllerError";
    this.causeName = causeName;
  }
}

function defaultMediaDevices(): MediaDevices {
  if (
    typeof navigator === "undefined" ||
    navigator.mediaDevices === undefined
  ) {
    throw new CameraControllerError(
      "このブラウザはカメラAPIに対応していません。",
      "NotSupportedError",
    );
  }
  return navigator.mediaDevices;
}

function describeCameraError(error: unknown): CameraControllerError {
  if (error instanceof DOMException) {
    const messages: Readonly<Record<string, string>> = {
      NotAllowedError: "カメラの使用が許可されていません。",
      NotFoundError: "利用できるカメラが見つかりません。",
      NotReadableError: "カメラが他のアプリで使用されています。",
      OverconstrainedError: "指定したカメラ設定を利用できません。",
      SecurityError: "安全なHTTPS接続でカメラを開いてください。",
    };
    return new CameraControllerError(
      messages[error.name] ?? error.message,
      error.name,
    );
  }
  return new CameraControllerError(
    error instanceof Error ? error.message : String(error),
  );
}

export class CameraController {
  private readonly mediaDevices: MediaDevices;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  public constructor(mediaDevices?: MediaDevices) {
    this.mediaDevices = mediaDevices ?? defaultMediaDevices();
  }

  public get active(): boolean {
    return this.stream !== null;
  }

  public async getDevices(): Promise<readonly CameraDevice[]> {
    const devices = await this.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `カメラ ${index + 1}`,
        groupId: device.groupId,
      }));
  }

  public async start(options: CameraStartOptions): Promise<CameraInfo> {
    this.stop();
    const width = options.width ?? DEFAULT_CAMERA_WIDTH;
    const height = options.height ?? DEFAULT_CAMERA_HEIGHT;
    const frameRate = options.frameRate ?? DEFAULT_CAMERA_FRAME_RATE;
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate },
      ...(options.deviceId === undefined
        ? { facingMode: { ideal: "user" } }
        : { deviceId: { exact: options.deviceId } }),
    };

    let stream: MediaStream;
    try {
      stream = await this.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints,
      });
    } catch (error) {
      throw describeCameraError(error);
    }

    this.stream = stream;
    this.video = options.video;
    const video = options.video;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (error) {
      this.stop();
      throw describeCameraError(error);
    }

    const track = stream.getVideoTracks()[0];
    if (track === undefined) {
      this.stop();
      throw new CameraControllerError(
        "カメラ映像トラックを取得できません。",
        "NotReadableError",
      );
    }
    const settings = track.getSettings();
    const devices = await this.getDevices();
    const selected = devices.find(
      (device) => device.deviceId === settings.deviceId,
    );
    return {
      stream,
      deviceId: settings.deviceId ?? null,
      label: selected?.label ?? track.label,
      width: settings.width ?? video.videoWidth ?? width,
      height: settings.height ?? video.videoHeight ?? height,
      frameRate: settings.frameRate ?? null,
    };
  }

  public stop(): void {
    const stream = this.stream;
    const video = this.video;
    this.stream = null;
    this.video = null;
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    if (video !== null) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
    }
  }
}
