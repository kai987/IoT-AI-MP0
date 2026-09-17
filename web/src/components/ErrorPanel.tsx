export interface ErrorPanelProps {
  readonly title: string;
  readonly message: string;
  readonly onRetry: () => void;
  readonly onKeyboardMode: () => void;
  readonly onMenu: () => void;
}

export function ErrorPanel({ title, message, onRetry, onKeyboardMode, onMenu }: ErrorPanelProps) {
  return (
    <section
      className="modal-panel error-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="camera-error-title"
      aria-describedby="camera-error-message"
    >
      <div role="alert" aria-live="assertive">
        <span className="error-panel__mark" aria-hidden="true">!</span>
        <h2 id="camera-error-title">{title}</h2>
        <p id="camera-error-message">{message}</p>
      </div>
      <button type="button" className="text-button" onClick={onMenu}>メニューでカメラ・設定を変更</button>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onRetry} autoFocus>カメラを再試行</button>
        <button type="button" className="primary-button" onClick={onKeyboardMode}>キーボードで続ける</button>
      </div>
    </section>
  );
}
