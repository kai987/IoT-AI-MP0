import type { RefObject } from "react";
import type { VisionStageTimings } from "../vision/types";

interface NormalizedBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CameraPanelSnapshot {
  readonly status: string;
  readonly emotion: string | null;
  readonly candidate: string | null;
  readonly confidence: number;
  readonly uncertain: boolean;
  readonly uncertaintyReason?: string;
  readonly faceCount: number;
  readonly aiFps: number;
  readonly backend: "webgpu" | "wasm" | null;
  readonly primaryBox: NormalizedBox | null;
  readonly cameraWidth: number;
  readonly cameraHeight: number;
  readonly cameraFps?: number;
  readonly analysisWidth?: number;
  readonly analysisHeight?: number;
  readonly startupSeconds?: number;
  readonly latencyMs?: number;
  readonly captureMs?: number;
  readonly latencyP50Ms?: number;
  readonly latencyP95Ms?: number;
  readonly stageTimings?: VisionStageTimings;
}

export interface CameraPanelProps {
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly snapshot: CameraPanelSnapshot;
  readonly onDisableCamera: () => void;
}

const EMOTION_JA: Readonly<Record<string, string>> = {
  neutral: "無表情",
  happiness: "喜び",
  surprise: "驚き",
  anger: "怒り",
  sadness: "悲しみ",
  disgust: "嫌悪",
  fear: "恐れ",
  contempt: "軽蔑",
};

const UNCERTAINTY_JA: Readonly<Record<string, string>> = {
  "no-face": "顔が見つかりません",
  small: "顔をカメラに近づけてください",
  blur: "顔がぼやけています",
  lighting: "明るさを調整してください",
  alignment: "顔を正面に向けてください",
  "low-confidence": "確信度が不足しています",
  "low-margin": "候補が近すぎます",
  "switch-pending": "表情の確認中です",
};

export function CameraPanel({ videoRef, snapshot, onDisableCamera }: CameraPanelProps) {
  const box = snapshot.primaryBox;
  const boxStyle = box === null ? undefined : {
    left: `${(1 - box.x - box.width) * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
  };
  const emotion = snapshot.emotion === null ? "--" : (EMOTION_JA[snapshot.emotion] ?? snapshot.emotion);
  const candidate = snapshot.candidate === null ? "--" : (EMOTION_JA[snapshot.candidate] ?? snapshot.candidate);
  const backend = snapshot.backend === null ? "--" : snapshot.backend === "webgpu" ? "WebGPU" : "WASM";
  const uncertainty = snapshot.uncertaintyReason === undefined
    ? "表情を保持してください"
    : (UNCERTAINTY_JA[snapshot.uncertaintyReason] ?? snapshot.uncertaintyReason);

  return (
    <aside className="camera-panel" aria-label="カメラと表情認識の状態">
      <div className="camera-panel__header">
        <span><i className="live-dot" aria-hidden="true" />カメラ：オン（ミラー）</span>
        <button type="button" onClick={onDisableCamera} aria-label="カメラを停止">停止</button>
      </div>
      <div className="video-frame" style={{ aspectRatio: `${snapshot.cameraWidth || 16} / ${snapshot.cameraHeight || 9}` }}>
        <video ref={videoRef} autoPlay muted playsInline aria-label="鏡像カメラプレビュー" />
        {boxStyle !== undefined && <span className="face-box" style={boxStyle} aria-hidden="true" />}
        {snapshot.status !== "running" && <span className="video-status">{snapshot.status}</span>}
      </div>
      <dl className="vision-stats" aria-live="polite">
        <div><dt>{snapshot.uncertain ? "判定" : "表情"}</dt><dd className={snapshot.uncertain ? "is-warning" : "is-ready"}>{snapshot.uncertain ? `判定不能・${uncertainty}` : emotion}</dd></div>
        <div><dt>信頼度</dt><dd>{Math.round(snapshot.confidence * 100)}%</dd></div>
        <div><dt>候補</dt><dd>{candidate}</dd></div>
        <div><dt>AI FPS</dt><dd>{snapshot.aiFps.toFixed(1)}・顔 {snapshot.faceCount}</dd></div>
        <div><dt>カメラ FPS</dt><dd>{snapshot.cameraFps?.toFixed(1) ?? "--"}</dd></div>
        <div><dt>Backend</dt><dd>{backend}</dd></div>
        <div><dt>入力</dt><dd>{snapshot.cameraWidth || "--"} × {snapshot.cameraHeight || "--"}</dd></div>
        <div><dt>解析入力</dt><dd>{snapshot.analysisWidth || "--"} × {snapshot.analysisHeight || "--"}</dd></div>
        <div><dt>AI準備</dt><dd>{snapshot.startupSeconds === undefined ? "--" : `${snapshot.startupSeconds.toFixed(1)} 秒`}</dd></div>
      </dl>
      <details className="vision-diagnostics">
        <summary>処理時間・入力遅延</summary>
        <dl className="vision-timings" aria-label="表情入力の遅延統計">
          <div><dt>入力遅延</dt><dd>{milliseconds(snapshot.latencyMs)}</dd></div>
          <div><dt>P50 / P95</dt><dd>{milliseconds(snapshot.latencyP50Ms)} / {milliseconds(snapshot.latencyP95Ms)}</dd></div>
          <div><dt>撮影・縮小</dt><dd>{milliseconds(snapshot.captureMs)}</dd></div>
          <div><dt>顔検出</dt><dd>{milliseconds(snapshot.stageTimings?.landmarksMs)}</dd></div>
          <div><dt>整列・品質</dt><dd>{milliseconds(snapshot.stageTimings?.alignmentQualityMs)}</dd></div>
          <div><dt>表情モデル</dt><dd>{milliseconds(snapshot.stageTimings?.classificationMs)}</dd></div>
          <div><dt>安定化</dt><dd>{milliseconds(snapshot.stageTimings?.smoothingMs)}</dd></div>
        </dl>
      </details>
    </aside>
  );
}

function milliseconds(value: number | undefined): string {
  return value === undefined ? "--" : `${Math.round(value)} ms`;
}
