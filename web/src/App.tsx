import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorPanel, GameCanvas, LoadingPanel, StartMenu, type CameraPanelSnapshot } from "./components";
import { AudioManager, GameAction, GameEngine, GameRenderer, GameState } from "./game";
import { SettingsStorage, type UserSettings } from "./storage";
import type { VisionController as VisionControllerClass } from "./vision/VisionController";
import type { VisionControllerEvent } from "./vision/types";

type AppScreen = "menu" | "loading" | "game" | "error";
type ControlMode = "camera" | "keyboard";

const EMPTY_VISION_SNAPSHOT: CameraPanelSnapshot = Object.freeze({
  status: "待機中",
  emotion: null,
  candidate: null,
  confidence: 0,
  uncertain: true,
  uncertaintyReason: "カメラ待機中",
  faceCount: 0,
  aiFps: 0,
  backend: null,
  primaryBox: null,
  cameraWidth: 0,
  cameraHeight: 0,
});

export function App() {
  const [settingsStorage] = useState(() => new SettingsStorage());
  const [initialSettings] = useState<UserSettings>(() => settingsStorage.load());
  const [audio] = useState(() => {
    const manager = new AudioManager();
    manager.setVolume(initialSettings.masterVolume);
    manager.setMuted(initialSettings.muted);
    return manager;
  });
  const engineRef = useRef<GameEngine | null>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const visionRef = useRef<VisionControllerClass | null>(null);
  const visionUnsubscribeRef = useRef<(() => void) | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameStatusRef = useRef<HTMLParagraphElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const launchSequenceRef = useRef(0);

  const [screen, setScreen] = useState<AppScreen>("menu");
  const [mode, setMode] = useState<ControlMode>(initialSettings.controlMode);
  const [volume, setVolumeState] = useState(initialSettings.masterVolume);
  const [muted, setMuted] = useState(initialSettings.muted);
  const [modelStatus, setModelStatus] = useState("AIモデルはカメラモード選択後に読み込みます");
  const [loadingDetail, setLoadingDetail] = useState("カメラを準備しています…");
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null);
  const [errorTitle, setErrorTitle] = useState("カメラを開始できませんでした");
  const [errorMessage, setErrorMessage] = useState("");
  const [visionSnapshot, setVisionSnapshot] = useState<CameraPanelSnapshot>(EMPTY_VISION_SNAPSHOT);

  const ensureEngine = useCallback((nextMode: ControlMode): GameEngine => {
    let engine = engineRef.current;
    if (engine === null) {
      engine = new GameEngine({ mode: nextMode, audio });
      engineRef.current = engine;
    } else {
      engine.setMode(nextMode, performance.now() / 1000);
    }
    return engine;
  }, [audio]);

  const persistSettings = useCallback((changes: Partial<UserSettings>) => {
    settingsStorage.patch(changes);
  }, [settingsStorage]);

  const initializeAudio = useCallback(async (): Promise<boolean> => {
    const enabled = await audio.initialize();
    if (!enabled) {
      setModelStatus("音声を開始できないため、無音モードで続行します");
    }
    return enabled;
  }, [audio]);

  const stopVision = useCallback(async () => {
    launchSequenceRef.current += 1;
    visionUnsubscribeRef.current?.();
    visionUnsubscribeRef.current = null;
    const vision = visionRef.current;
    visionRef.current = null;
    if (vision !== null) {
      await vision.stop().catch(() => undefined);
    }
    setVisionSnapshot(EMPTY_VISION_SNAPSHOT);
  }, []);

  const applyVisionEvent = useCallback((event: VisionControllerEvent) => {
    if (event.type === "status") {
      setLoadingDetail(event.message);
      setVisionSnapshot((current) => ({ ...current, status: event.message }));
      return;
    }
    if (event.type === "error") {
      if (event.recoverable) {
        setVisionSnapshot((current) => ({
          ...current,
          uncertain: true,
          uncertaintyReason: event.message,
        }));
        return;
      }
      const engine = engineRef.current;
      if (engine?.state === GameState.Playing) {
        engine.togglePause();
      }
      void stopVision();
      setErrorTitle("AI推論を開始できませんでした");
      setErrorMessage(event.message);
      setScreen("error");
      return;
    }
    const result = event.result;
    const nextSnapshot: CameraPanelSnapshot = {
      status: "running",
      emotion: result.emotion,
      candidate: result.candidate,
      confidence: result.confidence,
      uncertain: result.uncertain,
      uncertaintyReason: result.uncertaintyReason ?? undefined,
      faceCount: result.faceCount,
      aiFps: result.aiFps,
      backend: event.provider,
      primaryBox: result.faceBox,
      cameraWidth: result.cameraWidth,
      cameraHeight: result.cameraHeight,
    };
    setVisionSnapshot(nextSnapshot);
    engineRef.current?.updateEmotion(
      {
        emotion: result.emotion,
        confidence: result.confidence,
        features: result.features,
        uncertain: result.uncertain,
      },
      performance.now() / 1000,
    );
  }, [stopVision]);

  const beginCameraMode = useCallback(async () => {
    const launchSequence = launchSequenceRef.current + 1;
    launchSequenceRef.current = launchSequence;
    await stopVision();
    launchSequenceRef.current = launchSequence;
    setMode("camera");
    setScreen("loading");
    setLoadingProgress(null);
    setLoadingDetail("カメラの使用許可を確認しています…");
    setErrorMessage("");
    persistSettings({ controlMode: "camera" });
    const engine = ensureEngine("camera");
    if (await initializeAudio()) {
      audio.play("click");
    }
    await nextPaint();

    try {
      const video = videoRef.current;
      if (video === null) {
        throw new Error("カメラプレビューを初期化できませんでした。");
      }
      setLoadingDetail("AIモデルをブラウザに読み込んでいます…");
      setLoadingProgress(0.18);
      const module = await import("./vision");
      if (launchSequenceRef.current !== launchSequence) {
        return;
      }
      const vision = new module.VisionController();
      visionRef.current = vision;
      visionUnsubscribeRef.current = vision.subscribe(applyVisionEvent);
      setLoadingProgress(0.42);
      const camera = await vision.start({
        video,
        deviceId: initialSettings.cameraDeviceId ?? undefined,
        width: 1280,
        height: 720,
        frameRate: 30,
        initialAiFps: 12,
      });
      if (launchSequenceRef.current !== launchSequence) {
        await vision.stop();
        return;
      }
      setVisionSnapshot((current) => ({
        ...current,
        status: "running",
        cameraWidth: camera.width,
        cameraHeight: camera.height,
      }));
      persistSettings({
        controlMode: "camera",
        cameraDeviceId: camera.deviceId,
      });
      setModelStatus(`AIモデル準備完了・${camera.width}×${camera.height}`);
      setLoadingProgress(1);
      engine.start(performance.now() / 1000);
      setScreen("game");
      requestAnimationFrame(() => canvasRef.current?.focus());
    } catch (error: unknown) {
      if (launchSequenceRef.current !== launchSequence) {
        return;
      }
      await stopVision();
      const message = cameraErrorMessage(error);
      setErrorTitle(message.title);
      setErrorMessage(message.detail);
      setScreen("error");
    }
  }, [applyVisionEvent, audio, ensureEngine, initializeAudio, initialSettings.cameraDeviceId, persistSettings, stopVision]);

  const beginKeyboardMode = useCallback(async () => {
    await stopVision();
    setMode("keyboard");
    persistSettings({ controlMode: "keyboard" });
    if (await initializeAudio()) {
      audio.play("click");
    }
    const engine = ensureEngine("keyboard");
    engine.start(performance.now() / 1000);
    setScreen("game");
    requestAnimationFrame(() => canvasRef.current?.focus());
  }, [audio, ensureEngine, initializeAudio, persistSettings, stopVision]);

  const returnToMenu = useCallback(async () => {
    audio.play("click");
    await stopVision();
    engineRef.current?.returnToMenu();
    setScreen("menu");
    setModelStatus("AIモデルはカメラモード選択後に読み込みます");
  }, [audio, stopVision]);

  const setVolume = useCallback((nextVolume: number) => {
    const normalized = audio.setVolume(nextVolume);
    setVolumeState(normalized);
    persistSettings({ masterVolume: normalized });
    void initializeAudio().then((enabled) => {
      const engine = engineRef.current;
      if (enabled && (engine === null || engine.state === GameState.Menu)) {
        audio.playMusic("menu");
      }
    });
  }, [audio, initializeAudio, persistSettings]);

  const toggleMute = useCallback(() => {
    const wasMuted = audio.muted;
    if (!wasMuted) {
      audio.play("click");
    }
    const nextMuted = audio.toggleMute();
    setMuted(nextMuted);
    persistSettings({ muted: nextMuted });
    if (!nextMuted) {
      void initializeAudio().then((enabled) => {
        if (!enabled) {
          return;
        }
        const engine = engineRef.current;
        if (engine === null || engine.state === GameState.Menu) {
          audio.playMusic("menu");
        }
        audio.play("click");
      });
    }
  }, [audio, initializeAudio, persistSettings]);

  const requestAction = useCallback((action: GameAction) => {
    engineRef.current?.requestAction(action, "keyboard", performance.now() / 1000);
  }, []);

  const togglePause = useCallback(() => {
    engineRef.current?.togglePause();
  }, []);

  const restartGame = useCallback(() => {
    engineRef.current?.restart(performance.now() / 1000);
  }, []);

  const disableCamera = useCallback(async () => {
    audio.play("click");
    await stopVision();
    setMode("keyboard");
    engineRef.current?.setMode("keyboard", performance.now() / 1000);
    persistSettings({ controlMode: "keyboard", cameraDeviceId: null });
  }, [audio, persistSettings, stopVision]);

  const enterFullscreen = useCallback(async () => {
    audio.play("click");
    await document.documentElement.requestFullscreen();
  }, [audio]);

  useEffect(() => {
    document.body.dataset.muted = String(muted);
  }, [muted]);

  useEffect(() => {
    if (screen === "menu" || canvasRef.current === null) {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      return;
    }
    const renderer = new GameRenderer(
      canvasRef.current,
      undefined,
      gameStatusRef.current,
    );
    rendererRef.current = renderer;
    let frameRequest = 0;
    let previous = performance.now() / 1000;
    const frame = (timestampMs: number) => {
      const now = timestampMs / 1000;
      const delta = Math.max(0, now - previous);
      previous = now;
      const engine = engineRef.current;
      if (engine !== null) {
        engine.update(delta, now);
        renderer.draw(engine.getSnapshot(now), now);
      }
      frameRequest = requestAnimationFrame(frame);
    };
    frameRequest = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(frameRequest);
      renderer.dispose();
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
    };
  }, [screen]);

  useEffect(() => {
    if (screen === "menu") {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const engine = engineRef.current;
      if (engine === null) {
        return;
      }
      if (event.code === "Escape") {
        event.preventDefault();
        if (document.fullscreenElement !== null) {
          void document.exitFullscreen();
        } else {
          void returnToMenu();
        }
        return;
      }
      if (event.code === "KeyM") {
        event.preventDefault();
        toggleMute();
        return;
      }
      if (event.code === "KeyP") {
        event.preventDefault();
        togglePause();
        return;
      }
      if (
        engine.state === GameState.GameOver &&
        (event.code === "KeyR" || event.code === "Enter")
      ) {
        event.preventDefault();
        engine.restart(performance.now() / 1000);
        return;
      }
      const action = actionForCode(event.code);
      if (action !== null) {
        event.preventDefault();
        requestAction(action);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => { window.removeEventListener("keydown", handleKeyDown); };
  }, [requestAction, returnToMenu, screen, toggleMute, togglePause]);

  useEffect(() => {
    const cleanup = () => {
      visionUnsubscribeRef.current?.();
      visionRef.current?.stop().catch(() => undefined);
      audio.shutdown();
      rendererRef.current?.dispose();
    };
    window.addEventListener("pagehide", cleanup);
    return () => {
      window.removeEventListener("pagehide", cleanup);
      cleanup();
    };
  }, [audio]);

  const stageVisible = screen !== "menu";
  const fullscreenAvailable = typeof document.documentElement.requestFullscreen === "function";

  return (
    <main className="app-shell">
      {screen === "menu" && (
        <StartMenu
          volume={volume}
          muted={muted}
          modelStatus={modelStatus}
          busy={false}
          onVolumeChange={setVolume}
          onMuteToggle={toggleMute}
          onCameraMode={() => { void beginCameraMode(); }}
          onKeyboardMode={() => { void beginKeyboardMode(); }}
        />
      )}

      {stageVisible && (
        <GameCanvas
          canvasRef={canvasRef}
          gameStatusRef={gameStatusRef}
          videoRef={videoRef}
          mode={mode}
          visionSnapshot={visionSnapshot}
          onAction={requestAction}
          onPause={togglePause}
          onMute={toggleMute}
          onRestart={restartGame}
          onDisableCamera={() => { void disableCamera(); }}
        />
      )}

      {screen === "game" && (
        <nav className="top-controls" aria-label="ゲーム共通操作">
          {fullscreenAvailable && (
            <button type="button" onClick={() => { void enterFullscreen(); }}>
              全画面
            </button>
          )}
          <button type="button" onClick={() => { void returnToMenu(); }}>メニュー</button>
        </nav>
      )}

      {screen === "loading" && (
        <div className="modal-backdrop">
          <LoadingPanel
            title="ローカルAIを準備中"
            detail={loadingDetail}
            progress={loadingProgress}
            onCancel={() => { void returnToMenu(); }}
          />
        </div>
      )}

      {screen === "error" && (
        <div className="modal-backdrop">
          <ErrorPanel
            title={errorTitle}
            message={errorMessage}
            onRetry={() => { void beginCameraMode(); }}
            onKeyboardMode={() => { void beginKeyboardMode(); }}
          />
        </div>
      )}
    </main>
  );
}

function actionForCode(code: string): GameAction | null {
  switch (code) {
    case "Space":
      return GameAction.Jump;
    case "KeyS":
      return GameAction.Boost;
    case "KeyA":
      return GameAction.Attack;
    case "KeyD":
      return GameAction.Shield;
    default:
      return null;
  }
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => { resolve(); });
  });
}

function cameraErrorMessage(error: unknown): { title: string; detail: string } {
  const wrappedCause =
    typeof error === "object" &&
    error !== null &&
    "causeName" in error &&
    typeof error.causeName === "string"
      ? error.causeName
      : null;
  const name = wrappedCause ?? (error instanceof DOMException || error instanceof Error ? error.name : "");
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        title: "カメラの使用が許可されていません",
        detail: "ブラウザのサイト設定でカメラを許可して再試行するか、キーボードモードで続けてください。",
      };
    case "NotFoundError":
      return {
        title: "カメラが見つかりません",
        detail: "接続を確認して再試行するか、キーボードモードで続けてください。",
      };
    case "NotReadableError":
      return {
        title: "カメラを開けません",
        detail: "ほかのアプリがカメラを使用していないか確認して、もう一度お試しください。",
      };
    case "OverconstrainedError":
      return {
        title: "指定したカメラ設定を使用できません",
        detail: "ブラウザが利用可能な解像度で再試行してください。キーボード操作はそのまま使用できます。",
      };
    default:
      return {
        title: "カメラまたはAIを開始できませんでした",
        detail: error instanceof Error ? error.message : "不明なエラーが発生しました。",
      };
  }
}
