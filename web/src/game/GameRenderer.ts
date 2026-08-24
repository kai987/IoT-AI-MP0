import { ACTION_PRESENTATION, DEFAULT_GAME_SETTINGS, type GameSettings, type RgbColor } from "./Settings";
import { GameAction, GameState, type CoinSnapshot, type GameSnapshot, type ObstacleSnapshot, type PlayerSnapshot } from "./types";

const ACTION_ORDER = [
  GameAction.Jump,
  GameAction.Boost,
  GameAction.Attack,
  GameAction.Shield,
] as const;

const ACTION_COLORS: Readonly<Record<GameAction, RgbColor>> = {
  [GameAction.Jump]: [55, 221, 231],
  [GameAction.Boost]: [255, 205, 75],
  [GameAction.Attack]: [255, 132, 63],
  [GameAction.Shield]: [169, 107, 255],
};

export class GameRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly settings: GameSettings;
  private readonly liveRegion: HTMLParagraphElement | null;
  private readonly resizeObserver: ResizeObserver | null;
  private disposed = false;
  private lastAccessibleStatus = "";

  public constructor(
    canvas: HTMLCanvasElement,
    settings: GameSettings = DEFAULT_GAME_SETTINGS,
    liveRegion: HTMLParagraphElement | null = null,
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) {
      throw new Error("Canvas 2D を初期化できませんでした。");
    }
    this.canvas = canvas;
    this.context = context;
    this.settings = settings;
    this.liveRegion = liveRegion;
    this.resizeBackingStore();
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => { this.resizeBackingStore(); });
    this.resizeObserver?.observe(canvas);
  }

  public draw(snapshot: GameSnapshot, now: number): void {
    if (this.disposed) {
      return;
    }
    const context = this.context;
    const { width, height } = this.settings.window;
    this.canvas.dataset.gameState = snapshot.state;
    this.canvas.dataset.playerY = snapshot.player.y.toFixed(2);
    this.canvas.dataset.boosting = String(snapshot.player.boosting);
    this.canvas.dataset.attacking = String(snapshot.player.attacking);
    this.canvas.dataset.shielded = String(snapshot.player.shielded);
    this.canvas.dataset.score = Math.floor(snapshot.score).toString();
    this.canvas.dataset.highScore = snapshot.highScore.toString();
    this.updateAccessibleStatus(snapshot);
    const pixelRatio = this.pixelRatio();
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    this.drawSky();
    this.drawParallax(snapshot.distance);
    this.drawGround(snapshot.distance);
    snapshot.coins.forEach((coin, index) => {
      this.drawCoin(coin, Math.sin(now * 7 + index * 0.8));
    });
    snapshot.obstacles.forEach((obstacle) => {
      if (obstacle.alive) {
        this.drawObstacle(obstacle);
      }
    });
    this.drawPlayer(snapshot.player, now);
    this.drawHud(snapshot);
    this.drawSkillBar(snapshot, now);

    if (snapshot.actionTip !== null && now < snapshot.actionTip.expiresAt && snapshot.state === GameState.Playing) {
      this.drawActionTip(snapshot.actionTip.text);
    }
    if (snapshot.state === GameState.Paused) {
      this.drawOverlay("一時停止", "Pキーまたはボタンでゲームを再開");
    } else if (snapshot.state === GameState.GameOver) {
      this.drawGameOver(snapshot);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.resizeObserver?.disconnect();
  }

  private updateAccessibleStatus(snapshot: GameSnapshot): void {
    if (this.liveRegion === null) {
      return;
    }
    const action = snapshot.actionTip?.text ?? "";
    const statusKey = `${snapshot.state}:${snapshot.lives}:${action}`;
    if (statusKey === this.lastAccessibleStatus) {
      return;
    }
    this.lastAccessibleStatus = statusKey;
    if (snapshot.state === GameState.GameOver) {
      this.liveRegion.textContent =
        `ゲームオーバー。スコア${Math.floor(snapshot.score)}。` +
        "再スタートボタン、Rキー、またはEnterキーで再開できます。";
      return;
    }
    if (snapshot.state === GameState.Paused) {
      this.liveRegion.textContent =
        `一時停止中。残りライフ${snapshot.lives}。` +
        "一時停止ボタンまたはPキーで再開できます。";
      return;
    }
    this.liveRegion.textContent =
      `ゲーム実行中。残りライフ${snapshot.lives}。${action}`;
  }

  private resizeBackingStore(): void {
    const ratio = this.pixelRatio();
    const targetWidth = Math.round(this.settings.window.width * ratio);
    const targetHeight = Math.round(this.settings.window.height * ratio);
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }
  }

  private pixelRatio(): number {
    return Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  }

  private drawSky(): void {
    const gradient = this.context.createLinearGradient(0, 0, 0, this.settings.window.height);
    gradient.addColorStop(0, rgb(this.settings.colors.skyTop));
    gradient.addColorStop(1, rgb(this.settings.colors.skyBottom));
    this.context.fillStyle = gradient;
    this.context.fillRect(0, 0, this.settings.window.width, this.settings.window.height);

    this.context.fillStyle = "rgba(17, 40, 74, 0.68)";
    for (const cloud of [[60, 208, 140], [430, 172, 112], [832, 192, 164], [1080, 222, 128]] as const) {
      const [x, y, cloudWidth] = cloud;
      this.context.beginPath();
      this.context.moveTo(x, y);
      this.context.lineTo(x + cloudWidth * 0.18, y - 28);
      this.context.lineTo(x + cloudWidth * 0.43, y - 28);
      this.context.lineTo(x + cloudWidth * 0.53, y - 48);
      this.context.lineTo(x + cloudWidth * 0.72, y - 48);
      this.context.lineTo(x + cloudWidth, y);
      this.context.closePath();
      this.context.fill();
    }
  }

  private drawParallax(distance: number): void {
    const context = this.context;
    const offset = Math.floor(distance * 0.12) % 210;
    for (let index = -1; index < 8; index += 1) {
      const x = index * 210 - offset;
      const buildingHeight = 70 + positiveModulo(index * 37, 115);
      const y = this.settings.player.groundY - 130 - buildingHeight;
      context.fillStyle = "#263d59";
      roundedRect(context, x, y, 145, buildingHeight, 7);
      context.fill();
      context.fillStyle = "#648799";
      for (let row = y + 18; row < y + buildingHeight - 12; row += 24) {
        for (let column = x + 16; column < x + 133; column += 27) {
          roundedRect(context, column, row, 9, 7, 2);
          context.fill();
        }
      }
    }
  }

  private drawGround(distance: number): void {
    const context = this.context;
    const groundY = this.settings.player.groundY;
    context.fillStyle = rgb(this.settings.colors.ground);
    context.fillRect(0, groundY, this.settings.window.width, this.settings.window.height - groundY);
    context.fillStyle = rgb(this.settings.colors.groundLine);
    context.fillRect(0, groundY, this.settings.window.width, 4);
    const dashOffset = Math.floor(distance) % 80;
    context.strokeStyle = "#444d59";
    context.lineWidth = 4;
    for (let x = -80; x < this.settings.window.width + 80; x += 80) {
      context.beginPath();
      context.moveTo(x - dashOffset, 626);
      context.lineTo(x + 42 - dashOffset, 626);
      context.stroke();
    }
  }

  private drawCoin(coin: CoinSnapshot, phase: number): void {
    if (!coin.alive) {
      return;
    }
    const visibleWidth = Math.max(4, Math.round(coin.radius * (0.35 + 0.65 * Math.abs(phase))));
    const context = this.context;
    context.save();
    context.translate(coin.x, coin.y);
    context.scale(visibleWidth / coin.radius, 1);
    context.fillStyle = rgb(this.settings.colors.yellow);
    context.beginPath();
    context.arc(0, 0, coin.radius, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = "#ffef94";
    context.stroke();
    context.restore();
  }

  private drawObstacle(obstacle: ObstacleSnapshot): void {
    const { rect } = obstacle;
    const context = this.context;
    if (obstacle.kind === "rock") {
      context.fillStyle = "#717d8d";
      context.beginPath();
      context.moveTo(rect.x, rect.y + rect.height);
      context.lineTo(rect.x + 7, rect.y + 12);
      context.lineTo(rect.x + rect.width / 2, rect.y);
      context.lineTo(rect.x + rect.width - 3, rect.y + 15);
      context.lineTo(rect.x + rect.width, rect.y + rect.height);
      context.closePath();
      context.fill();
      context.strokeStyle = "#abb5c2";
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(rect.x + 7, rect.y + 12);
      context.lineTo(rect.x + rect.width / 2, rect.y);
      context.stroke();
      return;
    }
    if (obstacle.kind === "crate") {
      context.fillStyle = "#a45e2d";
      roundedRect(context, rect.x, rect.y, rect.width, rect.height, 5);
      context.fill();
      context.strokeStyle = "#eda650";
      context.lineWidth = 4;
      context.stroke();
      context.beginPath();
      context.moveTo(rect.x + 3, rect.y + 3);
      context.lineTo(rect.x + rect.width - 3, rect.y + rect.height - 3);
      context.moveTo(rect.x + rect.width - 3, rect.y + 3);
      context.lineTo(rect.x + 3, rect.y + rect.height - 3);
      context.stroke();
      return;
    }
    if (obstacle.kind === "enemy") {
      context.fillStyle = rgb(this.settings.colors.red);
      roundedRect(context, rect.x, rect.y, rect.width, rect.height, 14);
      context.fill();
      context.fillStyle = rgb(this.settings.colors.white);
      context.beginPath();
      context.arc(rect.x + 16, rect.y + 24, 6, 0, Math.PI * 2);
      context.arc(rect.x + rect.width - 16, rect.y + 24, 6, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = rgb(this.settings.colors.panel);
      context.beginPath();
      context.arc(rect.x + 16, rect.y + 24, 3, 0, Math.PI * 2);
      context.arc(rect.x + rect.width - 16, rect.y + 24, 3, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = rgb(this.settings.colors.panel);
      context.lineWidth = 4;
      context.beginPath();
      context.moveTo(rect.x + 14, rect.y + rect.height - 22);
      context.lineTo(rect.x + rect.width - 14, rect.y + rect.height - 22);
      context.stroke();
      return;
    }
    context.fillStyle = rgb(this.settings.colors.purple);
    roundedRect(context, rect.x, rect.y, rect.width, rect.height, 6);
    context.fill();
    context.strokeStyle = rgb(this.settings.colors.yellow);
    context.lineWidth = 5;
    for (let y = rect.y + 10; y < rect.y + rect.height; y += 20) {
      context.beginPath();
      context.moveTo(rect.x + 4, y);
      context.lineTo(rect.x + rect.width - 4, y + 12);
      context.stroke();
    }
  }

  private drawPlayer(player: PlayerSnapshot, now: number): void {
    if (player.invulnerable && Math.floor(now * 12) % 2 === 0) {
      return;
    }
    const context = this.context;
    const rect = player.rect;
    if (player.shielded) {
      const pulse = 5 + 3 * Math.sin(now * 8);
      context.fillStyle = "rgba(55, 221, 231, 0.18)";
      context.strokeStyle = "rgba(55, 221, 231, 0.85)";
      context.lineWidth = 3;
      context.beginPath();
      context.arc(rect.x + rect.width / 2, rect.y + rect.height / 2, 52 + pulse, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    const bodyColor = player.boosting ? this.settings.colors.yellow : this.settings.colors.cyan;
    const centerX = rect.x + rect.width / 2;
    const skin = "#ffd0aa";
    context.fillStyle = skin;
    context.beginPath();
    context.arc(centerX + 4, rect.y + 17, 15, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = rgb(bodyColor);
    context.lineCap = "round";
    context.lineWidth = 10;
    line(context, centerX, rect.y + 34, centerX - 2, rect.y + 67);
    const swing = player.onGround ? Math.sin(player.runPhase) * 15 : 6;
    context.strokeStyle = skin;
    context.lineWidth = 6;
    line(context, centerX, rect.y + 42, centerX + 21, rect.y + 50 + swing / 3);
    line(context, centerX - 1, rect.y + 43, centerX - 20, rect.y + 54 - swing / 3);
    context.strokeStyle = rgb(bodyColor);
    context.lineWidth = 8;
    line(context, centerX - 2, rect.y + 65, centerX + swing, rect.y + rect.height - 2);
    line(context, centerX - 2, rect.y + 65, centerX - swing, rect.y + rect.height - 2);
    context.lineCap = "butt";

    if (player.boosting) {
      context.strokeStyle = rgb(this.settings.colors.yellow);
      context.lineWidth = 3;
      for (let index = 0; index < 3; index += 1) {
        const y = rect.y + 46 + index * 11;
        line(context, rect.x - 16 - index * 12, y, rect.x - 2, y);
      }
    }
    if (player.attackRect !== null) {
      const attack = player.attackRect;
      const gradient = context.createRadialGradient(attack.x, attack.y + attack.height / 2, 2, attack.x, attack.y + attack.height / 2, attack.width);
      gradient.addColorStop(0, "rgba(255, 205, 75, 0.85)");
      gradient.addColorStop(1, "rgba(255, 132, 63, 0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.ellipse(attack.x + attack.width / 2, attack.y + attack.height / 2, attack.width / 2, attack.height / 2, 0, 0, Math.PI * 2);
      context.fill();
    }
  }

  private drawHud(snapshot: GameSnapshot): void {
    const context = this.context;
    const layout = this.settings.layout;
    context.fillStyle = "rgba(13, 20, 34, 0.91)";
    roundedRect(context, layout.hudX, layout.hudY, layout.hudWidth, layout.hudHeight, 18);
    context.fill();
    text(context, `スコア  ${Math.floor(snapshot.score).toString().padStart(6, "0")}`, layout.hudX + 22, layout.hudY + 22, 31, this.settings.colors.white);
    text(context, `ハイスコア  ${snapshot.highScore.toString().padStart(6, "0")}`, layout.hudX + 24, layout.hudY + 62, 18, this.settings.colors.muted);
    text(context, `コンボ  x${snapshot.combo}`, layout.hudX + 294, layout.hudY + 23, 23, this.settings.colors.yellow);
    text(context, `スピード  ${(snapshot.speed / 100).toFixed(1)}`, layout.hudX + 294, layout.hudY + 55, 23, this.settings.colors.cyan);
    text(context, `プレイ時間 ${formatElapsed(snapshot.elapsed)}`, layout.hudX + layout.hudTimeCenterXOffset, layout.hudY + layout.hudTimeCenterYOffset, 17, this.settings.colors.muted, "center");

    for (let index = 0; index < this.settings.player.initialLives; index += 1) {
      this.drawHeart(
        layout.hudX + 512 + index * 34,
        layout.hudY + 49,
        index < snapshot.lives ? this.settings.colors.red : this.settings.colors.panelLight,
      );
    }
    text(context, "P 一時停止  M ミュート", layout.hudX + 482, layout.hudY + 68, 17, this.settings.colors.muted);
  }

  private drawSkillBar(snapshot: GameSnapshot, now: number): void {
    const context = this.context;
    const cardWidth = 195;
    const gap = 12;
    const startX = (this.settings.window.width - (cardWidth * 4 + gap * 3)) / 2;
    const y = 635;
    ACTION_ORDER.forEach((action, index) => {
      const x = startX + index * (cardWidth + gap);
      const color = ACTION_COLORS[action];
      const presentation = ACTION_PRESENTATION[action];
      const active = snapshot.player.faceAction === action;
      const pending = snapshot.controller.heldAction === action && !active;
      context.fillStyle = active ? `rgba(${color.join(",")},0.17)` : "rgba(13, 20, 34, 0.94)";
      roundedRect(context, x, y, cardWidth, 68, 12);
      context.fill();
      context.lineWidth = active ? 4 : pending ? 3 : 2;
      context.strokeStyle = rgb(pending ? this.settings.colors.yellow : color);
      context.stroke();
      text(context, presentation.key, x + 13, y + 16, 17, color);
      const textOffset = action === GameAction.Jump
        ? this.settings.layout.skillCardSpaceTextXOffset
        : this.settings.layout.skillCardShortKeyTextXOffset;
      text(context, presentation.labelJa, x + textOffset, y + 9, 23, this.settings.colors.white);
      const subtext = active
        ? `${presentation.emotionJa}・実行中`
        : pending ? `${presentation.emotionJa}・次の動作` : presentation.emotionJa;
      text(context, subtext, x + textOffset, y + 39, 17, active ? this.settings.colors.green : pending ? this.settings.colors.yellow : this.settings.colors.muted);

      const cooldown = snapshot.cooldowns[action];
      if (cooldown > 0 && !active && !pending) {
        context.fillStyle = "rgba(4, 8, 15, 0.67)";
        roundedRect(context, x, y, cardWidth, 68, 12);
        context.fill();
        text(context, `${cooldown.toFixed(1)}s`, x + cardWidth / 2, y + 23, 23, this.settings.colors.white, "center");
        const total = actionCooldown(action, this.settings);
        context.fillStyle = rgb(color);
        roundedRect(context, x + 4, y + 62, (cardWidth - 8) * (1 - Math.min(1, cooldown / total)), 3, 2);
        context.fill();
      }
      if (active) {
        const cycle = 0.5 + 0.5 * Math.sin(now * 7);
        context.fillStyle = `rgba(${color.join(",")},${0.22 + cycle * 0.2})`;
        context.fillRect(x + 5, y + 63, (cardWidth - 10) * cycle, 2);
      }
    });
  }

  private drawActionTip(message: string): void {
    const context = this.context;
    const layout = this.settings.layout;
    context.fillStyle = `rgba(13, 20, 34, ${layout.actionTipBackgroundAlpha / 255})`;
    roundedRect(
      context,
      layout.actionTipCenterX - layout.actionTipWidth / 2,
      layout.actionTipCenterY - layout.actionTipHeight / 2,
      layout.actionTipWidth,
      layout.actionTipHeight,
      12,
    );
    context.fill();
    text(context, ellipsize(context, message, layout.actionTipWidth - 36, 30), layout.actionTipCenterX, layout.actionTipCenterY - 17, 30, this.settings.colors.yellow, "center");
  }

  private drawOverlay(title: string, subtitle: string): void {
    const context = this.context;
    context.fillStyle = "rgba(5, 9, 18, 0.76)";
    context.fillRect(0, 0, this.settings.window.width, this.settings.window.height);
    text(context, title, 640, 270, 76, this.settings.colors.white, "center");
    text(context, subtitle, 640, 382, 31, this.settings.colors.cyan, "center");
  }

  private drawGameOver(snapshot: GameSnapshot): void {
    const context = this.context;
    context.fillStyle = "rgba(8, 8, 18, 0.84)";
    context.fillRect(0, 0, this.settings.window.width, this.settings.window.height);
    text(context, "ゲームオーバー", 640, 170, 76, this.settings.colors.red, "center");
    text(context, `今回のスコア  ${Math.floor(snapshot.score)}`, 640, 290, 52, this.settings.colors.white, "center");
    text(context, `ハイスコア  ${snapshot.highScore}     ベストコンボ  x${snapshot.bestCombo}`, 640, 365, 24, this.settings.colors.yellow, "center");
    context.fillStyle = rgb(this.settings.colors.cyan);
    roundedRect(context, 415, 432, 450, 66, 16);
    context.fill();
    text(context, "R / ENTER  リスタート", 640, 448, 30, this.settings.colors.panel, "center");
    text(context, "ESC  メニューへ戻る", 640, 530, 18, this.settings.colors.muted, "center");
  }

  private drawHeart(x: number, y: number, color: RgbColor): void {
    const context = this.context;
    context.fillStyle = rgb(color);
    context.beginPath();
    context.arc(x - 6, y - 4, 7, 0, Math.PI * 2);
    context.arc(x + 6, y - 4, 7, 0, Math.PI * 2);
    context.moveTo(x - 13, y - 2);
    context.lineTo(x + 13, y - 2);
    context.lineTo(x, y + 15);
    context.closePath();
    context.fill();
  }
}

function rgb(color: RgbColor): string {
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function line(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function text(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  color: RgbColor,
  align: CanvasTextAlign = "left",
): void {
  context.save();
  context.fillStyle = rgb(color);
  context.font = `600 ${size}px "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif`;
  context.textAlign = align;
  context.textBaseline = "top";
  context.fillText(value, x, y);
  context.restore();
}

function ellipsize(context: CanvasRenderingContext2D, value: string, maxWidth: number, size: number): string {
  context.save();
  context.font = `600 ${size}px "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif`;
  if (context.measureText(value).width <= maxWidth) {
    context.restore();
    return value;
  }
  let shortened = value;
  while (shortened.length > 0 && context.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  context.restore();
  return `${shortened}…`;
}

function formatElapsed(seconds: number): string {
  const rounded = Math.round(Math.max(0, seconds) * 100) / 100;
  if (rounded < 60) {
    return `${rounded.toFixed(2).padStart(5, "0")}秒`;
  }
  const whole = Math.floor(rounded);
  return `${Math.floor(whole / 60)}分${String(whole % 60).padStart(2, "0")}秒`;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function actionCooldown(action: GameAction, settings: GameSettings): number {
  switch (action) {
    case GameAction.Jump:
      return settings.actions.jumpCooldown;
    case GameAction.Boost:
      return settings.actions.boostCooldown;
    case GameAction.Attack:
      return settings.actions.attackCooldown;
    case GameAction.Shield:
      return settings.actions.shieldCooldown;
  }
}
