export interface ErrorPanelProps {
  readonly title: string;
  readonly message: string;
  readonly onRetry: () => void;
  readonly onKeyboardMode: () => void;
}

export function ErrorPanel({ title, message, onRetry, onKeyboardMode }: ErrorPanelProps) {
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
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onRetry} autoFocus>カメラを再試行</button>
        <button type="button" className="primary-button" onClick={onKeyboardMode}>キーボードで続ける</button>
      </div>
    </section>
  );
}
