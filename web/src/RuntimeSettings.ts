import { DEFAULT_GAME_SETTINGS } from "./game/Settings";

interface PerformanceSettings {
  readonly label: string;
  readonly targetFps: number; // 描画上限 / 游戏渲染FPS上限，实际受屏幕刷新率限制。
  readonly width: number; // カメラ幅 / 摄像头请求宽度，使用ideal约束。
  readonly height: number; // カメラ高さ / 摄像头请求高度。
  readonly analysisWidth: number; // 解析幅の上限 / 送入AI的图像最大宽度，保持宽高比。
  readonly frameRate: number; // 撮影FPS / 摄像头请求帧率。
  readonly aiFps: number; // 初期推論FPS / AI自适应帧率初始值。
  readonly maxAiFps: number; // 推論上限 / AI自适应帧率上限。
  readonly analyzeEveryNFrames: number; // Nフレームごとに解析 / 每N个摄像头帧尝试推理，同时受AI帧率和背压限制。
  readonly pixelRatio: number; // 描画倍率の上限 / 限制高DPI画布像素倍率，降低GPU负载。
}

// 性能プリセット / 游戏帧率、摄像头采集与AI预算集中配置。
export const PERFORMANCE_PROFILES = {
  economy: {
    label: "省電力", targetFps: 30,
    width: 640, height: 360, analysisWidth: 480, frameRate: 30,
    aiFps: 8, maxAiFps: 10, analyzeEveryNFrames: 2, pixelRatio: 1,
  },
  balanced: {
    label: "バランス", targetFps: 60,
    width: DEFAULT_GAME_SETTINGS.camera.requestedWidth,
    height: DEFAULT_GAME_SETTINGS.camera.requestedHeight,
    analysisWidth: 640, frameRate: 30,
    aiFps: 12, maxAiFps: 15,
    analyzeEveryNFrames: DEFAULT_GAME_SETTINGS.window.analyzeEveryNFrames,
    pixelRatio: 1.5,
  },
  performance: {
    label: "高性能", targetFps: DEFAULT_GAME_SETTINGS.window.targetFps,
    width: 1920, height: 1080, analysisWidth: 960, frameRate: 30,
    aiFps: 20, maxAiFps: 20, analyzeEveryNFrames: 1, pixelRatio: 2,
  },
} as const satisfies Record<string, PerformanceSettings>;
export type PerformanceProfile = keyof typeof PERFORMANCE_PROFILES;
// 推論の監視 / 单帧超时及连续失败上限，防止旧结果无限续触发。
export const VISION_HEALTH = {
  frameTimeoutMs: 5_000, // 通常フレーム / 正常推理单帧超时（毫秒）。
  warmupTimeoutMs: 20_000, // 初回ウォームアップ / 第一次推理预热允许更长时间。
  maxConsecutiveErrors: 5, // 連続失敗上限 / 达到此次数后停止AI并显示恢复操作。
  initializationTimeoutMs: 45_000, // モデル読み込み / 模型下载及初始化超时。
} as const;
export const PRACTICE_EMOTIONS = ["neutral", "happiness", "surprise", "anger", "sadness"] as const;
export type PracticeEmotion = typeof PRACTICE_EMOTIONS[number];
export const EMOTION_NAMES: Record<PracticeEmotion, string> = { neutral: "無表情", happiness: "喜び", surprise: "驚き", anger: "怒り", sadness: "悲しみ" };
export type EmotionThresholds = Record<PracticeEmotion, number>;
// 確信度の初期しきい値 / 每种表情可独立调整，数值越低越容易触发。
export const DEFAULT_THRESHOLDS: EmotionThresholds = { neutral: 0.45, happiness: 0.45, surprise: 0.45, anger: 0.45, sadness: 0.45 };
