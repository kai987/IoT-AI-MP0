/**
 * Browser runtime constants ported from `emotion_runner/settings.py`.
 *
 * The core consumes this typed object instead of reading DOM state, which keeps
 * simulation tests deterministic and lets the renderer scale the 1280x720
 * logical coordinate system independently from the CSS pixel size.
 */

export type RgbColor = readonly [red: number, green: number, blue: number];

export interface GameSettings {
  readonly window: {
    readonly width: number;
    readonly height: number;
    readonly targetFps: number;
    readonly analyzeEveryNFrames: number;
    readonly title: string;
    readonly maxDeltaSeconds: number;
  };
  readonly layout: {
    readonly hudX: number;
    readonly hudY: number;
    readonly hudWidth: number;
    readonly hudHeight: number;
    readonly hudTimeCenterXOffset: number;
    readonly hudTimeCenterYOffset: number;
    readonly actionTipCenterX: number;
    readonly actionTipCenterY: number;
    readonly actionTipWidth: number;
    readonly actionTipHeight: number;
    readonly actionTipDuration: number;
    readonly actionTipStartDuration: number;
    readonly actionTipBackgroundAlpha: number;
    readonly skillCardSpaceTextXOffset: number;
    readonly skillCardShortKeyTextXOffset: number;
  };
  readonly player: {
    readonly groundY: number;
    readonly startX: number;
    readonly width: number;
    readonly height: number;
    readonly gravity: number;
    readonly jumpVelocity: number;
    readonly initialLives: number;
    readonly invulnerabilityDuration: number;
    readonly attackWidth: number;
    readonly attackHeight: number;
    readonly attackYOffset: number;
    readonly collisionInsetX: number;
    readonly collisionInsetY: number;
  };
  readonly speed: {
    readonly baseScroll: number;
    readonly maxScroll: number;
    readonly increasePerSecond: number;
    readonly boostMultiplier: number;
  };
  readonly actions: {
    readonly jumpCooldown: number;
    readonly boostCooldown: number;
    readonly attackCooldown: number;
    readonly shieldCooldown: number;
    readonly boostDuration: number;
    readonly attackDuration: number;
    readonly shieldDuration: number;
    readonly faceActionLossGrace: number;
  };
  readonly recognition: {
    readonly actionConfidenceThreshold: number;
    readonly strongClassifierConfidence: number;
    readonly surpriseMouthRatioThreshold: number;
    readonly surpriseJawOpenThreshold: number;
    readonly surpriseEyeWideThreshold: number;
    readonly surpriseBrowRaiseThreshold: number;
    readonly happinessSmileThreshold: number;
    readonly angerBrowFurrowThreshold: number;
  };
  readonly camera: {
    readonly requestedWidth: number;
    readonly requestedHeight: number;
    readonly previewWidth: number;
    readonly previewHeight: number;
    readonly panelX: number;
    readonly panelY: number;
  };
  readonly audio: {
    readonly sampleRate: number;
    readonly channels: number;
    readonly masterVolume: number;
    readonly musicVolume: number;
    readonly pausedMusicVolume: number;
    readonly effectsVolume: number;
    readonly minVolume: number;
    readonly maxVolume: number;
    readonly volumeStep: number;
  };
  readonly spawning: {
    readonly enemySpawnTime: number;
    readonly barrierSpawnTime: number;
    readonly obstacleMinInterval: number;
    readonly obstacleMaxInterval: number;
    readonly coinMinInterval: number;
    readonly coinMaxInterval: number;
    readonly initialObstacleTime: number;
    readonly initialCoinTime: number;
    readonly minimumObstacleInterval: number;
    readonly maximumDifficultyIntervalReduction: number;
    readonly difficultyRampSeconds: number;
    readonly coinGroupMin: number;
    readonly coinGroupMax: number;
    readonly highCoinProbability: number;
    readonly lowCoinHeight: number;
    readonly highCoinHeight: number;
    readonly coinSpacing: number;
    readonly coinArcHeight: number;
  };
  readonly scoring: {
    readonly distanceMultiplier: number;
    readonly coinValue: number;
    readonly boostedCoinValue: number;
    readonly passedObstacleValue: number;
    readonly shieldBlockValue: number;
    readonly comboStep: number;
    readonly maximumComboSteps: number;
  };
  readonly colors: {
    readonly skyTop: RgbColor;
    readonly skyBottom: RgbColor;
    readonly ground: RgbColor;
    readonly groundLine: RgbColor;
    readonly white: RgbColor;
    readonly muted: RgbColor;
    readonly panel: RgbColor;
    readonly panelLight: RgbColor;
    readonly cyan: RgbColor;
    readonly green: RgbColor;
    readonly yellow: RgbColor;
    readonly orange: RgbColor;
    readonly red: RgbColor;
    readonly purple: RgbColor;
    readonly blue: RgbColor;
  };
}

export const DEFAULT_GAME_SETTINGS = {
  // Python: emotion_runner/settings.py の WINDOW_*、TARGET_FPS、ANALYZE_EVERY_N_FRAMES。
  // Python对应：emotion_runner/settings.py 的窗口、游戏刷新率与分析间隔参数。
  window: {
    width: 1280,
    height: 720,
    targetFps: 120,
    analyzeEveryNFrames: 2,
    title: "Emotion Runner - Facial Expression Parkour",
    maxDeltaSeconds: 0.05,
  },
  // Python: settings.py の HUD_*、ACTION_TIP_*、SKILL_CARD_*。
  // Python对应：settings.py 的HUD、动作提示框与技能卡布局参数。
  layout: {
    hudX: 24,
    hudY: 20,
    hudWidth: 700,
    hudHeight: 102,
    hudTimeCenterXOffset: 580,
    hudTimeCenterYOffset: 25,
    actionTipCenterX: 640,
    actionTipCenterY: 170,
    actionTipWidth: 420,
    actionTipHeight: 54,
    actionTipDuration: 0.9,
    actionTipStartDuration: 0.8,
    actionTipBackgroundAlpha: 210,
    skillCardSpaceTextXOffset: 77,
    skillCardShortKeyTextXOffset: 47,
  },
  // Python: settings.py と player.py の GROUND_Y、PLAYER_*、GRAVITY、JUMP_*。
  // Python对应：settings.py 与 player.py 的地面、玩家物理、生命和碰撞参数。
  player: {
    groundY: 610,
    startX: 150,
    width: 58,
    height: 94,
    gravity: 2300,
    jumpVelocity: -900,
    initialLives: 5,
    invulnerabilityDuration: 1,
    attackWidth: 118,
    attackHeight: 54,
    attackYOffset: 18,
    collisionInsetX: 16,
    collisionInsetY: 8,
  },
  // Python: settings.py の BASE_SCROLL_SPEED、MAX_SCROLL_SPEED、SPEED_*、BOOST_*。
  // Python对应：settings.py 的跑酷速度、难度增长与加速倍率。
  speed: {
    baseScroll: 350,
    maxScroll: 650,
    increasePerSecond: 4,
    boostMultiplier: 1.65,
  },
  // Python: settings.py と action_controller.py の *_COOLDOWN、*_DURATION、FACE_ACTION_LOSS_GRACE。
  // Python对应：settings.py 与 action_controller.py 的动作冷却、周期和识别丢失容错。
  actions: {
    jumpCooldown: 1,
    boostCooldown: 4,
    attackCooldown: 1.5,
    shieldCooldown: 5,
    boostDuration: 2,
    attackDuration: 0.3,
    shieldDuration: 2,
    faceActionLossGrace: 0.45,
  },
  // Python: settings.py と action_controller.py の ACTION_CONFIDENCE_* と顔特徴しきい値。
  // Python对应：settings.py 与 action_controller.py 的置信度及面部特征门槛。
  recognition: {
    actionConfidenceThreshold: 0.4,
    strongClassifierConfidence: 0.7,
    surpriseMouthRatioThreshold: 0.8,
    surpriseJawOpenThreshold: 0.12,
    surpriseEyeWideThreshold: 0.12,
    surpriseBrowRaiseThreshold: 0.1,
    happinessSmileThreshold: 0.12,
    angerBrowFurrowThreshold: 0.75,
  },
  // Python: settings.py と camera_manager.py の CAMERA_PREVIEW_*、CAMERA_PANEL_*。
  // Python对应：settings.py 与 camera_manager.py 的摄像头请求和右上角预览布局。
  camera: {
    // Web版は転送・推論負荷を抑えるため、Python版1080pではなく720pをideal指定する。
    // Web版为降低传输与推理负载，使用720p ideal约束而不是Python版1080p。
    requestedWidth: 1280,
    requestedHeight: 720,
    previewWidth: 320,
    previewHeight: 180,
    panelX: 932,
    panelY: 24,
  },
  // Python: settings.py と audio.py の AUDIO_*。
  // Python对应：settings.py 与 audio.py 的采样率、总音量、BGM和音效参数。
  audio: {
    sampleRate: 44_100,
    channels: 2,
    masterVolume: 0.8,
    musicVolume: 0.34,
    pausedMusicVolume: 0.12,
    effectsVolume: 1,
    minVolume: 0,
    maxVolume: 1,
    volumeStep: 0.1,
  },
  // Python: settings.py、game.py、entities.py の出現時刻・生成間隔・コイン配置。
  // Python对应：settings.py、game.py、entities.py 的障碍生成、敌人时刻和金币编组。
  spawning: {
    enemySpawnTime: 15,
    barrierSpawnTime: 60,
    obstacleMinInterval: 1.5,
    obstacleMaxInterval: 2.1,
    coinMinInterval: 1.6,
    coinMaxInterval: 2.8,
    initialObstacleTime: 1.2,
    initialCoinTime: 1.7,
    minimumObstacleInterval: 0.82,
    maximumDifficultyIntervalReduction: 0.35,
    difficultyRampSeconds: 240,
    coinGroupMin: 3,
    coinGroupMax: 6,
    highCoinProbability: 0.48,
    lowCoinHeight: 72,
    highCoinHeight: 176,
    coinSpacing: 42,
    coinArcHeight: 24,
  },
  // Python: game.py と entities.py の距離、コイン、通過、シールド、コンボ得点。
  // Python对应：game.py 与 entities.py 的距离、金币、越障、护盾和连击分数。
  scoring: {
    distanceMultiplier: 0.1,
    coinValue: 50,
    boostedCoinValue: 100,
    passedObstacleValue: 100,
    shieldBlockValue: 100,
    comboStep: 0.1,
    maximumComboSteps: 10,
  },
  // Python: settings.py のゲームUI色定数 SKY_TOP ～ BLUE。
  // Python对应：settings.py 中 SKY_TOP 至 BLUE 的游戏界面颜色。
  colors: {
    skyTop: [18, 31, 58],
    skyBottom: [79, 121, 170],
    ground: [35, 42, 51],
    groundLine: [82, 219, 192],
    white: [245, 248, 255],
    muted: [171, 184, 202],
    panel: [13, 20, 34],
    panelLight: [28, 39, 58],
    cyan: [55, 221, 231],
    green: [80, 220, 126],
    yellow: [255, 205, 75],
    orange: [255, 132, 63],
    red: [245, 74, 91],
    purple: [169, 107, 255],
    blue: [68, 142, 255],
  },
} as const satisfies GameSettings;

export const ACTION_PRESENTATION = {
  jump: { key: "SPACE", emotionJa: "喜び", labelJa: "ジャンプ" },
  boost: { key: "S", emotionJa: "驚き", labelJa: "ブースト" },
  attack: { key: "A", emotionJa: "怒り", labelJa: "攻撃" },
  shield: { key: "D", emotionJa: "悲しみ", labelJa: "シールド" },
} as const;

export const EMOTION_LABELS_JA = {
  neutral: "無表情",
  happiness: "喜び",
  surprise: "驚き",
  sadness: "悲しみ",
  anger: "怒り",
  disgust: "嫌悪",
  fear: "恐れ",
  contempt: "軽蔑",
} as const;
