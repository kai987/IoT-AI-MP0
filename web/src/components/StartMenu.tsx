import type { ChangeEvent } from "react";

export interface StartMenuProps {
  readonly volume: number;
  readonly muted: boolean;
  readonly modelStatus: string;
  readonly busy: boolean;
  readonly onVolumeChange: (volume: number) => void;
  readonly onMuteToggle: () => void;
  readonly onCameraMode: () => void;
  readonly onKeyboardMode: () => void;
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
}: StartMenuProps) {
  const secureCamera = window.isSecureContext && "mediaDevices" in navigator;
  const webGpuAvailable = "gpu" in navigator;

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
