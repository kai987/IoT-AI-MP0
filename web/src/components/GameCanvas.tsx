import type { RefObject } from "react";
import type { GameAction } from "../game/types";
import { CameraPanel, type CameraPanelSnapshot } from "./CameraPanel";
import { TouchControls } from "./TouchControls";

export interface GameCanvasProps {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly gameStatusRef: RefObject<HTMLParagraphElement | null>;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly mode: "camera" | "keyboard";
  readonly visionSnapshot: CameraPanelSnapshot;
  readonly onAction: (action: GameAction) => void;
  readonly onPause: () => void;
  readonly onMute: () => void;
  readonly onRestart: () => void;
  readonly onDisableCamera: () => void;
}

export function GameCanvas({
  canvasRef,
  gameStatusRef,
  videoRef,
  mode,
  visionSnapshot,
  onAction,
  onPause,
  onMute,
  onRestart,
  onDisableCamera,
}: GameCanvasProps) {
  return (
    <section className="game-stage" aria-label="Emotion Runner ゲーム画面">
      <canvas
        ref={canvasRef}
        className="game-canvas"
        width="1280"
        height="720"
        tabIndex={0}
        aria-label="自動で走るキャラクターを表情またはキーボードで操作するゲーム。SPACE はジャンプ、S はブースト、A は攻撃、D はシールドです。"
        aria-describedby="game-live-status"
        data-testid="game-canvas"
      />
      <p
        ref={gameStatusRef}
        id="game-live-status"
        className="sr-only"
        aria-live="polite"
      >ゲームを準備しています。</p>
      {mode === "camera" && (
        <CameraPanel videoRef={videoRef} snapshot={visionSnapshot} onDisableCamera={onDisableCamera} />
      )}
      <div className="mode-indicator" aria-live="polite">
        {mode === "camera" ? "表情 + キーボード" : "キーボードモード"}
      </div>
      <TouchControls
        onAction={onAction}
        onPause={onPause}
        onMute={onMute}
        onRestart={onRestart}
      />
    </section>
  );
}
