# MP-0 リアルタイム複数顔・表情認識


OpenCV DNNでカメラ映像の複数の顔を検出し、各顔の外見上の表情をリアルタイムに表示するプロジェクトです。ゲーム操作用にMediaPipe Face Landmarkerの478点と52種のblendshapeから口・眉・目の特徴量も抽出します。DeepFaceおよびTensorFlow Pythonフレームワークは使用しません。

## 推論の流れ

1. YuNetで顔と、両目・鼻・口両端の5点ランドマークを検出する。
2. 5点を使って顔の位置と回転を揃え、224×224の顔画像を作る。
3. EmotiEffLib/HSEmotionの `enet_b0_8_best_vgaf.onnx` に、RGB変換とImageNet正規化を行った顔を入力する。
4. MediaPipe Face Landmarkerから478点の顔ランドマークと52種のblendshapeを得て、口の開き、眉上げ、眉の収縮、笑顔、目の見開きを数値化する。
5. 表情確率と顔動作特徴に別々の指数移動平均（EMA）を適用し、1回だけの跳ねを抑える。
6. 顔画像の品質が不足している場合、最大確率が45%未満の場合、または上位2クラスの差が10ポイント未満の場合は、8表情のどれかに強制せず「判定不能」と表示する。

表情クラス：怒り、軽蔑、嫌悪、恐れ、喜び、無表情、悲しみ、驚き

## ファイル構成

```text
MP-0/
├── MP-0.ipynb
├── emotion_recognition.py
├── emotion_runner/
│   ├── main.py               # CLI入口
│   ├── game.py               # ゲームループ、描画、得点、状態
│   ├── camera_worker.py      # 独立プロセスのカメラとAI推論
│   ├── action_controller.py  # 表情判定、継続動作、冷却
│   ├── audio.py              # BGMと効果音のリアルタイム合成・再生
│   ├── player.py             # プレイヤー物理と4種類のスキル
│   ├── entities.py           # 障害物とコイン
│   ├── settings.py           # HUD、カメラ、音量、速度、閾値
│   └── data/high_score.json
├── requirements.txt
├── README.md
└── models/
    ├── face_detection_yunet_2023mar.onnx
    ├── enet_b0_8_best_vgaf.onnx
    ├── face_landmarker.task
    ├── LICENSE-YUNET.txt
    ├── LICENSE-EMOTIEFFLIB.txt
    ├── LICENSE-MEDIAPIPE.txt
    ├── MODEL_SOURCES.md
    └── 旧SSD/FERPlusモデル（比較・バックアップ用）
```

## セットアップ

```bash
cd "/path/to/IoT-AI-MP0"
python3 -m pip install -r requirements.txt
```

`requirements.txt` は `opencv-contrib-python==4.13.0.92` と `mediapipe==0.10.35` を使用します。`opencv-python` と `opencv-contrib-python` を同時に入れると `cv2` が競合するため、contrib版だけを使用します。

## macOSアプリのビルド

PyInstallerの `--windowed`、`--onedir` 構成で、Finderからダブルクリックできる `dist/Emotion Runner.app` を作成できます。ゲーム用のクリーンなPython 3.12環境を推奨します。

### ビルド環境の作成

```bash
python3.12 -m venv .venv-app
source .venv-app/bin/activate
python -m pip install --upgrade pip wheel
python -m pip install -r requirements-app.txt
```

`requirements-app.txt` にはゲーム、カメラ、AI推論、アプリ作成に必要な直接依存関係だけを記載しています。JupyterとIPythonは含みません。matplotlibはMediaPipeの依存関係として自動的に導入されます。また、OpenCVは `opencv-contrib-python` だけを使用します。

完成したmacOSアプリでは、MediaPipeの描画・音声・ドキュメント用の未使用モジュールを同梱せず、Face Landmarkerに必要な部分だけを起動時に読み込みます。推論モデル、前処理、閾値、表情ラベルは変更しません。

### ビルドと起動

```bash
scripts/build_macos_app.sh
open "dist/Emotion Runner.app"
```

カメラを起動せずにキーボード操作だけを確認する場合：

```bash
open "dist/Emotion Runner.app" --args --no-camera
```

ビルドスクリプトは単体テスト、ソース版smoke test、PyInstallerビルド、アプリ版smoke test、Info.plistのカメラ説明、コード署名を順に確認します。スクリプト自身は実カメラを起動しません。

### カメラ権限

初回のカメラ起動時にmacOSの権限ダイアログが表示されます。拒否した場合や映像を取得できない場合も、ゲームはSpace、S、A、Dによるキーボード操作を継続できます。後から許可する場合は、次を開いてください。

```text
システム設定
→ プライバシーとセキュリティ
→ カメラ
→ Emotion Runner
```

自動カメラ選択では、利用できる場合だけFFmpegからAVFoundationのデバイス名を取得します。FinderのPATHにFFmpegがない場合やHomebrewをインストールしていない場合は、OpenCVでindex 0～5を順に探索するため、FFmpegは必須ではありません。手動指定には `open "dist/Emotion Runner.app" --args --camera 0` を使用できます。

### ユーザーデータとログ

アプリ内のリソースは読み取り専用として扱い、最高得点、ログ、スクリーンショットを `.app` の中へ書き込みません。

```text
最高得点：~/Library/Application Support/Emotion Runner/high_score.json
実行ログ：~/Library/Logs/Emotion Runner/EmotionRunner.log
スクリーンショット：~/Pictures/Emotion Runner/
```

自動テストでは `EMOTION_RUNNER_DATA_DIR` 環境変数で最高得点の保存先を一時ディレクトリに変更できます。旧 `emotion_runner/data/high_score.json` が存在し、新しい保存先にまだファイルがない場合は、初回起動時にコピーします。

### CPUアーキテクチャと配布

ビルド結果は、ビルドに使ったPythonとネイティブwheelのCPUアーキテクチャを引き継ぎます。Apple Siliconではarm64、Intel Macではx86_64のPython環境を別々に用意してビルドしてください。この手順はuniversal2アプリを生成しません。

通常のローカルビルドはPyInstallerによるad-hoc署名で動作確認できます。第三者へ配布する場合は、`CODESIGN_IDENTITY` にDeveloper ID Application証明書名を設定して再ビルドし、Appleのnotarizationとstaplingを別途実施してください。Apple ID、Team ID、パスワード、証明書名はリポジトリへ保存しないでください。

## Emotion Runner 第一版

1280×720のPygameウィンドウで動作する、表情操作の自動走行ゲームです。プレイヤーの初期ライフは5です。カメラ・OpenCV・MediaPipeは独立したPythonプロセスで実行し、Pygame側は設定値の120 FPSを上限として入力と描画を続けます。この分離により、AI推論中もゲームウィンドウの終了・一時停止操作が固まりにくくなります。

起動：

```bash
cd "/path/to/IoT-AI-MP0"
python3 -m emotion_runner
```

MacBook内蔵カメラはAVFoundationの名前から自動選択します。手動でindexを指定する場合は `python3 -m emotion_runner --camera 0`、カメラなしでゲームだけを確認する場合は `python3 -m emotion_runner --no-camera` を使用します。VS Code Notebookのセル内ではなく、VS Codeのターミナルから起動してください。

操作：

| 表情                            | 動作               | キーボード |
| ------------------------------- | ------------------ | ---------- |
| `surprise` + 口開き・眉上げ等 | 表情を保つ間、ブーストを継続 | `S` |
| `happiness` + smile | 表情を保つ間、着地後すぐ再ジャンプ | `Space` |
| `anger` + 眉収縮 | 表情を保つ間、攻撃を継続 | `A` |
| `sadness` | 表情を保つ間、シールドを継続 | `D` |
| `neutral` または別の表情 | 現在の継続動作を停止・切替 | — |

表情が変化しても、実行中の動作を途中では中断しません。変更後の表情は「次の動作」として保存され、現在の動作が完了したフレームで最新の表情へ切り替えます。完了条件は、ジャンプが着地、ブーストが2秒、攻撃が0.3秒、シールドが2秒（または衝突で使用）です。同じ表情を保っている場合は、同じ動作を次のサイクルでも繰り返します。

- `Enter` または `Space`：開始画面からゲーム開始
- `P`：一時停止／再開
- `M`：BGMと効果音のミュート／解除
- `R` または `Enter`：ゲームオーバー画面から再スタート
- `Esc` またはウィンドウを閉じる：カメラプロセスを終了して退出

開始画面の「スタート」とゲームオーバー画面の「リスタート」は、マウスでもクリックできます。
開始画面の音量「－」「＋」ボタンでは、BGMとすべての効果音を10%単位で0%から100%まで調整できます。ミュート中に音量ボタンを押すとミュートを解除します。

画面右上にはカメラ映像、表情、確信度、AI FPSを表示します。表情の確信度や上位2クラス差が不足しているときは「判定不能」と表示します。認識の一時的な揺れでは動作を0.45秒だけ保持し、その間に同じ表情へ戻れば動作を継続します。最初の15秒はジャンプ障害物が中心で、15秒後に木箱と敵、60秒後に大型障害物を追加します。

### BGMと効果音

音声は `audio.py` が起動時に波形を合成するため、外部の音源ファイルや著作権素材を使用しません。

| 場面 | 音声 |
| --- | --- |
| 開始メニュー | 落ち着いたアルペジオBGM |
| ゲーム中 | テンポの速いチップチューンBGM |
| コイン取得・障害物通過 | 得点音 |
| ジャンプ・ブースト・攻撃・シールド | 4種類それぞれ異なる動作音 |
| 木箱・敵の破壊 | 破壊音 |
| シールドで防御 | 防御音 |
| ダメージ | 被弾音 |
| ライフが0 | 死亡音とBGMフェードアウト |
| ボタンクリック・開始・一時停止・再開 | 個別のUI音 |
| 空中での再ジャンプ失敗 | エラー音 |

音声デバイスを初期化できない場合は自動的に無音モードとなり、ゲームとカメラ認識はそのまま実行できます。

### settings.py で調整できる主な項目

`emotion_runner/settings.py` にゲームの調整値を集約しています。ゲーム描画は `TARGET_FPS=120`、完全な表情分析は `ANALYZE_EVERY_N_FRAMES=2`、敵と木箱の出現開始は `ENEMY_SPAWN_TIME=15.0` で調整できます。HUDは `HUD_X`, `HUD_Y`, `HUD_WIDTH=700`, `HUD_HEIGHT`、動作ヒントは `ACTION_TIP_CENTER_X`, `ACTION_TIP_CENTER_Y`, `ACTION_TIP_WIDTH`, `ACTION_TIP_HEIGHT` で位置と大きさを変更できます。現在のヒント上端はHUD下端より21px下です。

音量は `AUDIO_MASTER_VOLUME`, `AUDIO_MUSIC_VOLUME`, `AUDIO_PAUSED_MUSIC_VOLUME`, `AUDIO_EFFECTS_VOLUME`, `AUDIO_MIN_VOLUME`, `AUDIO_MAX_VOLUME`, `AUDIO_VOLUME_STEP` で調整できます。カメラは `CAMERA_INDEX=None` でMacBook内蔵カメラを名前から自動選択し、0や1などの数値にするとindexを固定します。設定値の意味と単位は同ファイル内のコメントに記載しています。

動作確認：

```bash
python3 -m unittest tests.test_emotion_runner -v
python3 -m emotion_runner --smoke-test --seed 7
```

## ゲーム操作用の顔動作特徴

各 `FaceTrack` の `facial_features` から次の値を取得できます。値はすべてEMAで平滑化されます。

| 属性                 | 意味                    | 主な用途             |
| -------------------- | ----------------------- | -------------------- |
| `mouth_open_ratio` | 内側の唇間距離 ÷ 口幅  | surpriseの張り口確認 |
| `jaw_open`         | MediaPipeの顎開きスコア | ジャンプの補助判定   |
| `brow_raise`       | 内眉・外眉の上げスコア  | surpriseの眉上げ確認 |
| `brow_furrow`      | 左右の眉下げスコア      | angerの補助判定      |
| `smile`            | 左右の口角上げスコア    | happinessの補助判定  |
| `eye_wide`         | 左右の目の見開きスコア  | surpriseの補助判定   |

カメラ画面下部に、最初に検出した人の `mouth`、`jaw`、`brow+`、`brow-`、`smile` を表示します。ゲームの閾値は実際に自分で表情を作ったときの数値を見て決めます。

ゲーム側からは、1フレームの `process_frame()` 後に次のように取得できます。

```python
from emotion_recognition import box_size

if app.visible_tracks:
    player_track = max(app.visible_tracks, key=lambda track: box_size(track.box))
    emotion_index = player_track.emotion_index
    confidence = player_track.emotion_confidence
    features = player_track.facial_features
    if features is not None:
        print(features.mouth_open_ratio, features.brow_raise)
```

## Jupyter Notebookで実行

`MP-0.ipynb` を開き、カーネルを再起動してから上から順に実行します。VS CodeではOpenCV/Cocoaの別ウィンドウを作らず、映像をNotebookの出力欄に表示します。カメラ処理はバックグラウンドで動くため、赤い `カメラを停止` ボタンが反応します。

カメラには1920×1080（1080p）を要求し、実際に取得できたフル解像度を検出・認識・保存に使います。Notebookのプレビューも1920×1080で送信し、プレビュー更新は最大12 FPSです。カメラが1080pを受理しない場合は実解像度をボタン横に表示します。

Notebookの `CAMERA_INDEX = None` でAVFoundationのデバイス名からMacBook内蔵カメラを自動選択します。indexが変化してもiPhoneカメラへの自動回避は行いません。

Notebookの操作：

- `カメラを停止`：カメラを解放してバックグラウンド処理を終了
- `画像を保存`：認識結果を `MP-0_emotion_result.jpg` に保存

## Pythonファイルを直接実行

```bash
python3 emotion_recognition.py
```

`--camera` を省略するとMacBook内蔵カメラを名前で選択します。手動指定は `python3 emotion_recognition.py --camera 1` のように実行します。

直接実行時の操作：

- `s`：認識結果を保存
- 画面右上の `QUIT`、右クリック、またはウィンドウを閉じる：終了
- OpenCV画面にフォーカスを置いて `q`、`Q`、または `ESC`：終了

## 静止画像で確認

```bash
python3 emotion_recognition.py --image "/path/to/photo.jpg"
```

## 認識精度を下げにくくする撮影条件

- 顔をできるだけ正面に向け、両目・眉・口を隠さない。
- 顔の縦横が最低80ピクセル以上になる距離で使用する。
- 逆光と顔への強い影を避け、カメラの正面から柔らかく照らす。
- 表情は瞬間的に作らず、1秒程度保持する。
- 「判定不能」は故障ではなく、誤った表情名を出さないための仕様である。

必要に応じて `emotion_recognition.py` 先頭の `EMOTION_CONFIDENCE_THRESHOLD`、`EMOTION_MARGIN_THRESHOLD`、`MIN_FACE_SHARPNESS` を調整できます。閾値を下げると表情名は出やすくなりますが、誤分類も増えます。

## 注意事項

- macOSの「システム設定」→「プライバシーとセキュリティ」→「カメラ」でVisual Studio Codeを許可してください。
- カメラの許可を変更した後はVisual Studio Codeを完全に終了して開き直してください。
- Python環境を切り替えた後はNotebookのカーネルを再起動してください。
- 表示結果は顔の外見上の表情分類であり、本人の本当の感情を判断するものではありません。
- 人が交差したり画面外へ出たりすると、簡易トラッカーのIDが変わる場合があります。

## 学習済みモデル

- 顔検出：[OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)（MIT License）
- 表情分類：[EmotiEffLib / HSEmotion](https://github.com/sb-ai-lab/EmotiEffLib) `enet_b0_8_best_vgaf`（Apache License 2.0）
- 顔ランドマークとblendshape：[MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/python)（Apache License 2.0）

取得先URLとSHA-256は `models/MODEL_SOURCES.md` に記録しています。旧SSD/CaffeモデルとFERPlusモデルは比較用に残していますが、デフォルト実行では読み込みません。
