import { GameAction } from "../game/types";

export interface TouchControlsProps {
  readonly onAction: (action: GameAction) => void;
  readonly onPause: () => void;
  readonly onMute: () => void;
  readonly onRestart: () => void;
}

const ACTIONS: ReadonlyArray<{ action: GameAction; label: string; className: string }> = [
  { action: GameAction.Jump, label: "ジャンプ", className: "touch-jump" },
  { action: GameAction.Boost, label: "ブースト", className: "touch-boost" },
  { action: GameAction.Attack, label: "攻撃", className: "touch-attack" },
  { action: GameAction.Shield, label: "シールド", className: "touch-shield" },
];

export function TouchControls({ onAction, onPause, onMute, onRestart }: TouchControlsProps) {
  return (
    <nav className="touch-controls" aria-label="タッチ操作">
      {ACTIONS.map(({ action, label, className }) => (
        <button key={action} type="button" className={className} onClick={() => { onAction(action); }}>
          {label}
        </button>
      ))}
      <button type="button" onClick={onPause}>一時停止</button>
      <button type="button" onClick={onMute}>ミュート</button>
      <button type="button" className="touch-restart" onClick={onRestart}>再スタート</button>
    </nav>
  );
}
