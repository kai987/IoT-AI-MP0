export interface LoadingPanelProps {
  readonly title: string;
  readonly detail: string;
  readonly progress: number | null;
  readonly onCancel: () => void;
}

export function LoadingPanel({ title, detail, progress, onCancel }: LoadingPanelProps) {
  const safeProgress = progress === null ? null : Math.max(0, Math.min(1, progress));
  return (
    <section
      className="modal-panel loading-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="loading-title"
      aria-describedby="loading-detail"
    >
      <div className="loading-mark" aria-hidden="true"><span /></div>
      <h2 id="loading-title">{title}</h2>
      <p id="loading-detail" role="status" aria-live="polite">{detail}</p>
      <div className="progress-track" aria-hidden="true">
        <span
          className={safeProgress === null ? "is-indeterminate" : ""}
          style={safeProgress === null ? undefined : { width: `${safeProgress * 100}%` }}
        />
      </div>
      <button type="button" className="text-button" onClick={onCancel} autoFocus>キャンセル</button>
    </section>
  );
}
