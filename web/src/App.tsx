import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorPanel, GameCanvas, LoadingPanel, StartMenu, type CameraPanelSnapshot } from "./components";
import { AudioManager, GameAction, GameEngine, GameRenderer, GameState } from "./game";
import { SettingsStorage, type UserSettings } from "./storage";
import type { VisionController as VisionControllerClass } from "./vision/VisionController";
import type { VisionControllerEvent } from "./vision/types";
import type { CameraDevice } from "./vision/types";
import { DEFAULT_GAME_SETTINGS } from "./game/Settings";
import { PERFORMANCE_PROFILES, type EmotionThresholds, type PracticeEmotion } from "./RuntimeSettings";
import { CalibrationPanel, type PracticeReport } from "./components/CalibrationPanel";

type AppScreen = "menu" | "loading" | "game" | "practice" | "error";
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
  const fpsRef = useRef<HTMLOutputElement | null>(null);
  const lastVisionAt = useRef(Number.NEGATIVE_INFINITY);
  const lastVisionUiAt = useRef(0);
  const startupSeconds = useRef<number | undefined>(undefined);
  const practiceMeasurement = useRef<{ startedAt: number; report: PracticeReport } | null>(null);
  const [practiceReport, setPracticeReport] = useState<PracticeReport | null>(null);
  const [performanceProfile, setPerformanceProfile] = useState(initialSettings.performanceProfile);
  const profile = PERFORMANCE_PROFILES[performanceProfile];
  const [cameraDeviceId, setCameraDeviceId] = useState(initialSettings.cameraDeviceId);
  const [cameras, setCameras] = useState<readonly CameraDevice[]>([]);
  const [cameraMessage, setCameraMessage] = useState("カメラ名は使用許可後に表示されます。");
  const [thresholds, setThresholds] = useState(initialSettings.emotionThresholds);

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
    const engine = new GameEngine({ mode: nextMode, audio });
    engineRef.current = engine;
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
    setVisionSnapshot(EMPTY_VISION_SNAPSHOT);
    lastVisionAt.current = Number.NEGATIVE_INFINITY;
    startupSeconds.current = undefined;
    engineRef.current?.invalidateEmotion();
    if (vision !== null) {
      await vision.stop().catch(() => undefined);
    }
  }, []);

  const applyVisionEvent = useCallback((event: VisionControllerEvent) => {
    if (event.type === "status") {
      setLoadingDetail(event.message);
      setVisionSnapshot((current) => ({ ...current, status: event.message }));
      return;
    }
    if (event.type === "error") {
      if (event.recoverable) {
        engineRef.current?.invalidateEmotion();
        setVisionSnapshot((current) => ({
          ...current,
          uncertain: true,
          uncertaintyReason: event.message,
        }));
        return;
      }
      const engine = engineRef.current;
      if (engine?.state === GameState.Playing) {
        engine.togglePause(performance.now() / 1000);
      }
      void stopVision();
      setErrorTitle("AI推論を開始できませんでした");
      setErrorMessage(event.message);
      setScreen("error");
      return;
    }
    const result = event.result;
    const receivedAt = performance.now();
    // 撮影時刻を保持 / 使用采集时间而非返回时间，避免迟到结果被当成新输入。
    lastVisionAt.current = result.timestampMs;
    const stale = receivedAt - result.timestampMs > DEFAULT_GAME_SETTINGS.recognition.sampleMaxAgeSeconds * 1000;
    const nextSnapshot: CameraPanelSnapshot = {
      status: "running",
      emotion: result.emotion,
      candidate: result.candidate,
      confidence: result.confidence,
      uncertain: result.uncertain || stale,
      uncertaintyReason: stale ? "表情情報の更新を待っています" : result.uncertaintyReason ?? undefined,
      faceCount: result.faceCount,
      aiFps: result.aiFps,
      backend: event.provider,
      primaryBox: result.faceBox,
      cameraWidth: result.cameraWidth,
      cameraHeight: result.cameraHeight,
      cameraFps: result.cameraFps,
      analysisWidth: result.analysisWidth,
      analysisHeight: result.analysisHeight,
      startupSeconds: startupSeconds.current,
    };
    if (receivedAt - lastVisionUiAt.current >= 100) {
      setVisionSnapshot(nextSnapshot);
      lastVisionUiAt.current = receivedAt;
    }
    const measurement = practiceMeasurement.current;
    if (measurement !== null && !measurement.report.finished && result.timestampMs >= measurement.startedAt && receivedAt - measurement.startedAt < 3000) {
      const matched = !nextSnapshot.uncertain && result.emotion === measurement.report.target;
      measurement.report = { ...measurement.report, count: measurement.report.count + 1, matched: measurement.report.matched + Number(matched), uncertain: measurement.report.uncertain + Number(nextSnapshot.uncertain), latencyMs: measurement.report.latencyMs ?? (matched ? receivedAt - measurement.startedAt : null) };
    }
    engineRef.current?.updateEmotion(
      {
        emotion: result.emotion,
        confidence: result.confidence,
        features: result.features,
        uncertain: result.uncertain || stale,
      },
      result.timestampMs / 1000,
    );
  }, [stopVision]);

  const beginCameraMode = useCallback(async (practice = false) => {
    const stopped = stopVision();
    const launchSequence = launchSequenceRef.current;
    setMode("camera");
    setScreen("loading");
    await stopped;
    if (launchSequenceRef.current !== launchSequence) return;
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
      setLoadingProgress(null);
      const module = await import("./vision");
      if (launchSequenceRef.current !== launchSequence) {
        return;
      }
      const vision = new module.VisionController();
      visionRef.current = vision;
      visionUnsubscribeRef.current = vision.subscribe(applyVisionEvent);
      const startedAt = performance.now();
      const camera = await vision.start({
        video,
        deviceId: cameraDeviceId ?? undefined,
        width: profile.width,
        height: profile.height,
        frameRate: profile.frameRate,
        initialAiFps: profile.aiFps,
        maxAiFps: profile.maxAiFps,
        analyzeEveryNFrames: profile.analyzeEveryNFrames,
        analysisWidth: profile.analysisWidth,
      });
      await vision.waitForFirstResult();
      if (launchSequenceRef.current !== launchSequence) {
        await vision.stop();
        return;
      }
      vision.updateOptions({ emotionThresholds: thresholds });
      const availableCameras = await vision.getDevices();
      if (launchSequenceRef.current !== launchSequence) return;
      setCameras(availableCameras);
      setCameraDeviceId(camera.deviceId);
      startupSeconds.current = (performance.now() - startedAt) / 1000;
      setVisionSnapshot((current) => ({
        ...current,
        status: "running",
        cameraWidth: camera.width,
        cameraHeight: camera.height,
        startupSeconds: startupSeconds.current,
      }));
      persistSettings({
        controlMode: "camera",
        cameraDeviceId: camera.deviceId,
      });
      setModelStatus(`AI準備 ${((performance.now() - startedAt) / 1000).toFixed(1)}秒・${camera.width}×${camera.height}`);
      setLoadingProgress(1);
      practiceMeasurement.current = null;
      setPracticeReport(null);
      if (!practice) engine.start(performance.now() / 1000);
      setScreen(practice ? "practice" : "game");
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
  }, [applyVisionEvent, audio, ensureEngine, initializeAudio, cameraDeviceId, profile, thresholds, persistSettings, stopVision]);

  const beginKeyboardMode = useCallback(async () => {
    const stopping = stopVision();
    const sequence = launchSequenceRef.current;
    await stopping;
    if (sequence !== launchSequenceRef.current) return;
    setMode("keyboard");
    persistSettings({ controlMode: "keyboard" });
    if (await initializeAudio()) {
      audio.play("click");
    }
    if (sequence !== launchSequenceRef.current) return;
    const engine = ensureEngine("keyboard");
    engine.start(performance.now() / 1000);
    setScreen("game");
    requestAnimationFrame(() => canvasRef.current?.focus());
  }, [audio, ensureEngine, initializeAudio, persistSettings, stopVision]);

  const returnToMenu = useCallback(async () => {
    audio.play("click");
    const stopping = stopVision();
    engineRef.current?.returnToMenu();
    setScreen("menu");
    setModelStatus("AIモデルはカメラモード選択後に読み込みます");
    await stopping;
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
    engineRef.current?.togglePause(performance.now() / 1000);
  }, []);

  const restartGame = useCallback(() => {
    engineRef.current?.restart(performance.now() / 1000);
  }, []);

  const disableCamera = useCallback(async () => {
    audio.play("click");
    const stopping = stopVision();
    setMode("keyboard");
    engineRef.current?.setMode("keyboard", performance.now() / 1000);
    persistSettings({ controlMode: "keyboard", cameraDeviceId: null });
    await stopping;
  }, [audio, persistSettings, stopVision]);

  const enterFullscreen = useCallback(async () => {
    audio.play("click");
    await document.documentElement.requestFullscreen();
  }, [audio]);

  const updateThresholds = useCallback((next: EmotionThresholds) => {
    setThresholds(next);
    persistSettings({ emotionThresholds: next });
    visionRef.current?.updateOptions({ emotionThresholds: next });
    engineRef.current?.invalidateEmotion();
  }, [persistSettings]);

  const refreshCameras = useCallback(async () => {
    setCameraMessage("カメラの許可を確認しています…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      stream.getTracks().forEach((track) => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((device) => device.kind === "videoinput").map((device, index) => ({ deviceId: device.deviceId, label: device.label || `カメラ ${index + 1}`, groupId: device.groupId })));
      setCameraMessage("使用するカメラを選択してください。プレビューは開始していません。");
    } catch (error) {
      setCameraMessage(cameraErrorMessage(error).detail);
    }
  }, []);

  useEffect(() => {
    if (screen !== "game" && screen !== "practice") return;
    const timer = setInterval(() => {
      if (mode === "camera" && performance.now() - lastVisionAt.current > DEFAULT_GAME_SETTINGS.recognition.sampleMaxAgeSeconds * 1000) {
        engineRef.current?.invalidateEmotion();
        setVisionSnapshot((current) => current.uncertain && current.aiFps === 0 ? current : { ...current, uncertain: true, aiFps: 0, uncertaintyReason: "表情情報の更新を待っています" });
      }
      const measurement = practiceMeasurement.current;
      if (measurement !== null && !measurement.report.finished) {
        if (performance.now() - measurement.startedAt >= 3000) measurement.report = { ...measurement.report, finished: true };
        setPracticeReport({ ...measurement.report });
      }
    }, 150);
    return () => clearInterval(timer);
  }, [mode, screen]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden && engineRef.current?.state === GameState.Playing) {
        engineRef.current.togglePause(performance.now() / 1000);
        engineRef.current.invalidateEmotion();
      }
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

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
      profile.pixelRatio,
    );
    rendererRef.current = renderer;
    let frameRequest = 0;
    let previous = performance.now() / 1000;
    let lastRendered = 0;
    let measuredFrames = 0;
    let measuredAt = previous;
    const frame = (timestampMs: number) => {
      const now = timestampMs / 1000;
      const targetFps = engineRef.current?.state === GameState.Playing ? profile.targetFps : Math.min(profile.targetFps, 15);
      const interval = 1000 / targetFps;
      if (timestampMs - lastRendered < interval - 0.5) {
        frameRequest = requestAnimationFrame(frame);
        return;
      }
      lastRendered = timestampMs - Math.max(0, timestampMs - lastRendered) % interval;
      const delta = Math.max(0, now - previous);
      previous = now;
      const engine = engineRef.current;
      if (engine !== null) {
        engine.update(delta, now);
        renderer.draw(engine.getSnapshot(now), now);
        engine.drainEvents();
        measuredFrames += 1;
        if (now - measuredAt >= 0.5) {
          if (fpsRef.current) fpsRef.current.textContent = `ゲーム ${(measuredFrames / (now - measuredAt)).toFixed(1)} FPS`;
          measuredFrames = 0;
          measuredAt = now;
        }
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
  }, [screen, profile]);

  useEffect(() => {
    if (screen === "menu") {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const engine = engineRef.current;
      if (engine === null) {
        return;
      }
      if (event.code !== "Escape" && event.target instanceof HTMLElement && (event.target.matches("input, select, textarea") || (event.target.matches("button") && ["Space", "Enter"].includes(event.code)))) return;
      if (screen !== "game" && event.code !== "Escape") return;
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
          performanceProfile={performanceProfile}
          onProfileChange={(value) => { setPerformanceProfile(value); persistSettings({ performanceProfile: value }); }}
          cameras={cameras}
          cameraDeviceId={cameraDeviceId}
          onCameraChange={(value) => { setCameraDeviceId(value); persistSettings({ cameraDeviceId: value }); }}
          onRefreshCameras={() => { void refreshCameras(); }}
          onPractice={() => { void beginCameraMode(true); }}
          cameraMessage={cameraMessage}
        />
      )}

      {stageVisible && (
        <GameCanvas
          canvasRef={canvasRef}
          gameStatusRef={gameStatusRef}
          fpsRef={fpsRef}
          videoRef={videoRef}
          mode={mode}
          visionSnapshot={visionSnapshot}
          onAction={requestAction}
          onPause={togglePause}
          onMute={toggleMute}
          onRestart={restartGame}
          onDisableCamera={() => { void (screen === "practice" ? returnToMenu() : disableCamera()); }}
          interactive={screen === "game"}
        />
      )}

      {(screen === "game" || screen === "practice") && (
        <nav className="top-controls" aria-label="ゲーム共通操作">
          {fullscreenAvailable && (
            <button type="button" onClick={() => { void enterFullscreen(); }}>
              全画面
            </button>
          )}
          <button type="button" onClick={() => { void returnToMenu(); }}>メニュー</button>
        </nav>
      )}

      {screen === "practice" && <CalibrationPanel thresholds={thresholds} report={practiceReport} onThresholds={updateThresholds} onMeasure={(target: PracticeEmotion) => {
        const report = { target, count: 0, matched: 0, uncertain: 0, latencyMs: null, finished: false };
        practiceMeasurement.current = { startedAt: performance.now(), report };
        visionRef.current?.reset();
        setPracticeReport(report);
      }} onPlay={() => { engineRef.current?.start(performance.now() / 1000); setScreen("game"); requestAnimationFrame(() => canvasRef.current?.focus()); }} />}

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
            onMenu={() => { void returnToMenu(); }}
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
