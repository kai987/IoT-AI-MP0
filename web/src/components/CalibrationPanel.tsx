import { DEFAULT_THRESHOLDS, EMOTION_NAMES, PRACTICE_EMOTIONS, type EmotionThresholds, type PracticeEmotion } from "../RuntimeSettings";

export interface PracticeReport {
  readonly target: PracticeEmotion;
  readonly count: number;
  readonly matched: number;
  readonly uncertain: number;
  readonly latencyMs: number | null;
  readonly finished: boolean;
}

export function CalibrationPanel({ thresholds, report, onThresholds, onMeasure, onPlay }: {
  thresholds: EmotionThresholds;
  report: PracticeReport | null;
  onThresholds: (value: EmotionThresholds) => void;
  onMeasure: (emotion: PracticeEmotion) => void;
  onPlay: () => void;
}) {
  return <section className="calibration-panel" aria-labelledby="practice-title">
    <h2 id="practice-title">表情の練習・感度調整</h2>
    <p>顔を正面に向け、明るさを整えてください。測定ボタンを押し、目標の表情を3秒間続けます。</p>
    <p>しきい値を下げると反応しやすくなりますが、誤反応も増えます。</p>
    <div className="calibration-controls">
      {PRACTICE_EMOTIONS.map((emotion) => <div className="calibration-row" key={emotion}>
        <label htmlFor={`threshold-${emotion}`}>{EMOTION_NAMES[emotion]} <output>{Math.round(thresholds[emotion] * 100)}%</output></label>
        <input id={`threshold-${emotion}`} type="range" min="40" max="85" step="1" value={Math.round(thresholds[emotion] * 100)} onChange={(event) => onThresholds({ ...thresholds, [emotion]: Number(event.target.value) / 100 })} />
        <button type="button" disabled={report !== null && !report.finished} onClick={() => onMeasure(emotion)}>{EMOTION_NAMES[emotion]}を測定</button>
      </div>)}
    </div>
    <div className="practice-report" role="status" aria-live="polite">
      {report === null ? "測定結果はこの画面だけに表示されます。" : <>
        <strong>{EMOTION_NAMES[report.target]}：{report.finished ? "測定完了" : "測定中…"}</strong>
        <p>一致 {report.matched} / {report.count} 回（{report.count ? Math.round(report.matched / report.count * 100) : 0}%）・判定不能 {report.uncertain} 回</p>
        <p>別の表情 {report.count - report.matched - report.uncertain} 回・初回一致まで {report.latencyMs === null ? "未検出" : `${Math.round(report.latencyMs)} ms`}</p>
      </>}
    </div>
    <p className="practice-disclaimer">これは自己申告の目標との一致率で、モデルの一般的な正解率ではありません。映像・測定履歴は保存せず、感度設定のみ端末内に保存します。</p>
    <div className="practice-actions">
      <button type="button" onClick={() => onThresholds({ ...DEFAULT_THRESHOLDS })}>感度を初期値に戻す</button>
      <button type="button" className="primary-button" onClick={onPlay}>この設定でゲーム開始</button>
    </div>
  </section>;
}
