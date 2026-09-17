import type { ChangeEvent } from "react";
import { PERFORMANCE_PROFILES, type PerformanceProfile } from "../RuntimeSettings";
import type { CameraDevice } from "../vision/types";

export interface StartMenuProps {
  readonly volume: number;
  readonly muted: boolean;
  readonly modelStatus: string;
  readonly busy: boolean;
  readonly onVolumeChange: (volume: number) => void;
  readonly onMuteToggle: () => void;
  readonly onCameraMode: () => void;
  readonly onKeyboardMode: () => void;
  readonly performanceProfile: PerformanceProfile;
  readonly onProfileChange: (value: PerformanceProfile) => void;
  readonly cameras: readonly CameraDevice[];
  readonly cameraDeviceId: string | null;
  readonly onCameraChange: (value: string | null) => void;
  readonly onRefreshCameras: () => void;
  readonly onPractice: () => void;
  readonly cameraMessage: string;
}

export function StartMenu({
  volume,
  muted,
  modelStatus,
  busy,
  onVolumeChange,
  onMuteToggle,
  onCameraMode,
  onKeyboardMode,
  performanceProfile, onProfileChange, cameras, cameraDeviceId, onCameraChange, onRefreshCameras, onPractice, cameraMessage,
}: StartMenuProps) {
  const secureCamera = window.isSecureContext && "mediaDevices" in navigator;
  const webGpuAvailable = Reflect.get(navigator, "gpu") != null;

  const updateVolume = (event: ChangeEvent<HTMLInputElement>) => {
    onVolumeChange(Number(event.currentTarget.value) / 100);
  };

  return (
    <section className="start-menu" aria-labelledby="game-title">
      <div className="start-menu__intro">
        <h1 id="game-title">Emotion Runner</h1>
        <p className="start-menu__jp-title">表情で駆ける、ローカルAIランナー</p>
        <p className="start-menu__lead">
          喜びでジャンプ、驚きでブースト。表情またはキーボードで障害物を突破しよう。
        </p>
      </div>

      <div className="mode-actions" aria-label="ゲームモード">
        <button
          className="mode-button mode-button--camera"
          type="button"
          onClick={onCameraMode}
          disabled={busy || !secureCamera}
          data-testid="camera-mode"
        >
          <span className="mode-button__icon" aria-hidden="true">●</span>
          <span>
            <strong>カメラモード</strong>
            <small>表情AIをブラウザ内で実行</small>
          </span>
        </button>
        <button
          className="mode-button mode-button--keyboard"
          type="button"
          onClick={onKeyboardMode}
          disabled={busy}
          data-testid="keyboard-mode"
        >
          <span className="mode-button__key" aria-hidden="true">⌨</span>
          <span>
            <strong>キーボードモード</strong>
            <small>AIを読み込まず、すぐに開始</small>
          </span>
        </button>
      </div>

      <div className="menu-grid">
        <section className="menu-section runtime-options" aria-labelledby="runtime-title">
          <h2 id="runtime-title">カメラ・パフォーマンス</h2>
          <label htmlFor="performance-profile">動作モード</label>
          <select id="performance-profile" value={performanceProfile} onChange={(event) => onProfileChange(event.target.value as PerformanceProfile)}>
            {Object.entries(PERFORMANCE_PROFILES).map(([key, value]) => <option key={key} value={key}>{value.label}・最大{value.targetFps} FPS</option>)}
          </select>
          <p>{PERFORMANCE_PROFILES[performanceProfile].width}×{PERFORMANCE_PROFILES[performanceProfile].height}（要求値）・AI 最大{PERFORMANCE_PROFILES[performanceProfile].maxAiFps} FPS</p>
          <label htmlFor="camera-device">使用するカメラ</label>
          <select id="camera-device" value={cameraDeviceId ?? ""} onChange={(event) => onCameraChange(event.target.value || null)}>
            <option value="">ブラウザの既定カメラ</option>
            {cameraDeviceId && !cameras.some((camera) => camera.deviceId === cameraDeviceId) && <option value={cameraDeviceId}>保存済みカメラ（未確認）</option>}
            {cameras.filter((camera) => camera.deviceId).map((camera) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
          </select>
          <div className="practice-actions">
            <button type="button" disabled={!secureCamera} onClick={onRefreshCameras}>カメラを許可して一覧更新</button>
            <button type="button" disabled={!secureCamera || busy} onClick={onPractice}>表情を練習・調整</button>
          </div>
          <p role="status">{cameraMessage}</p>
        </section>
        <section className="menu-section" aria-labelledby="controls-title">
          <h2 id="controls-title">操作</h2>
          <dl className="control-list">
            <div><dt>SPACE</dt><dd>ジャンプ・喜び</dd></div>
            <div><dt>S</dt><dd>ブースト・驚き</dd></div>
            <div><dt>A</dt><dd>攻撃・怒り</dd></div>
            <div><dt>D</dt><dd>シールド・悲しみ</dd></div>
            <div><dt>P / M</dt><dd>一時停止 / ミュート</dd></div>
          </dl>
        </section>

        <section className="menu-section" aria-labelledby="sound-title">
          <h2 id="sound-title">サウンド</h2>
          <div className="volume-row">
            <button
              type="button"
              className="icon-button"
              onClick={onMuteToggle}
              aria-label={muted ? "ミュートを解除" : "ミュート"}
              aria-pressed={muted}
            >
              {muted ? "×" : "♪"}
            </button>
            <label htmlFor="master-volume">音量</label>
            <input
              id="master-volume"
              type="range"
              min="0"
              max="100"
              step="1"
              value={Math.round(volume * 100)}
              onChange={updateVolume}
            />
            <output htmlFor="master-volume">{muted ? "OFF" : `${Math.round(volume * 100)}%`}</output>
          </div>
          <p className="status-line" aria-live="polite">{modelStatus}</p>
        </section>
      </div>

      <div className="privacy-note">
        <strong>プライバシー</strong>
        <p>カメラ映像と顔情報はブラウザ内だけで処理され、サーバーには送信されません。</p>
        <p>画像・ランドマーク・表情履歴は保存されません。</p>
      </div>

      <footer className="compatibility-line">
        <span className={secureCamera ? "is-ready" : "is-warning"}>
          {secureCamera ? "安全な接続" : "カメラには HTTPS または localhost が必要です"}
        </span>
        <span>{webGpuAvailable ? "WebGPU 対応" : "WASM モードで動作"}</span>
      </footer>
    </section>
  );
}
