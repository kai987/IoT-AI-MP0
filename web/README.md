# Emotion Runner Web

Emotion Runner Webは、カメラの表情認識でジャンプ、ブースト、攻撃、シールドを操作するランゲームのブラウザ版です。React、Canvas 2D、Web Worker、MediaPipe Tasks Vision、ONNX Runtime Web、Web Audioを使用します。カメラから表情認識までをブラウザ内で実行する静的Webアプリであり、Pythonサーバーや外部AI APIは必要ありません。

> 中文：Emotion Runner Web 是表情控制跑酷游戏的纯浏览器版。它使用 React、Canvas 2D、Web Worker、MediaPipe Tasks Vision、ONNX Runtime Web 和 Web Audio，不需要 Python 服务器或外部 AI API。

## Python/macOS版との関係 / 与 Python/macOS 版的关系

リポジトリ直下のPythonコードと `dist/Emotion Runner.app` はデスクトップ版、`web/` はブラウザ版です。どちらかを削除する必要はなく、利用目的に応じて選択できます。

- macOS版：Python、Pygame、OpenCV、MediaPipe Pythonを使用し、Finderから独立アプリとして実行します。
- Web版：URLを開くだけで実行し、カメラの権限はブラウザが管理します。
- ゲームルールは共通です。初期ライフは5、表情を保持すると同じ動作サイクルを繰り返し、表情を変えると現在のサイクル完了後に新しい動作へ切り替わります。
- Web版のカメラ要求は `ideal: 1280×720 / 30 FPS`、AI解析は12 FPSから開始して端末性能に応じ6〜20 FPSで調整します。実際の解像度とFPSはブラウザとカメラが決定します。

> 中文：桌面版与 Web 版并存，共用游戏规则，但使用不同的运行时。Web 版摄像头请求为 ideal 1280×720/30 FPS，AI 从12 FPS开始，并在6〜20 FPS内自适应。

## プライバシーとデータフロー / 隐私与数据流

```text
カメラ MediaStream
  ↓ ブラウザ内でImageBitmap化
Web Worker
  ├─ MediaPipe Face Landmarker：顔、478点、blendshape
  ├─ Canvas/OffscreenCanvas：顔位置合わせと224×224前処理
  └─ ONNX Runtime Web：8表情の分類
  ↓ 表情名、確信度、顔特徴、顔枠のみ
メインスレッドのゲーム
```

- カメラ映像、切り出した顔、ランドマーク、表情履歴はネットワークへ送信しません。
- モデルとWASM/JavaScriptはすべて同じオリジンから配信します。本番ビルドはCDNや外部AIエンドポイントを参照しません。
- アナリティクス、テレメトリ、トラッキング、アカウント機能はありません。
- カメラを無効化する、メニューへ戻る、またはタブを閉じると、MediaStreamのトラックと推論Workerを停止します。
- ブラウザの `localStorage` に保存するのは次の2種類のみです。

| キー | 内容 |
| --- | --- |
| `emotion-runner.web.high-score` | ハイスコア |
| `emotion-runner.web.settings` | マスター音量、ミュート、カメラのデバイスID、操作モード |

顔画像や表情内容は `localStorage` に保存しません。保存値を削除する場合は、ブラウザの「サイトデータを削除」を使用してください。静的ホストには通常のHTML、JavaScript、WASM、モデルのHTTPリクエストは届きますが、カメラ内容は含まれません。

> 中文：所有图像处理均在当前浏览器标签页内完成。不上传摄像头画面、人脸图像、关键点或表情历史。只在 localStorage 中保存最高分和音量/静音/摄像头ID/操作模式设置，不保存人脸内容。

## 実行モード / 运行模式

### カメラ + 表情モード

1. 開始メニューで「カメラモード」を選択します。
2. ブラウザのカメラ許可で「許可」を選択します。
3. モデルと実行ランタイムの初回読み込みを待ちます。
4. 右上パネルに表情、確信度、AI FPS、WebGPU/WASMの利用状態が表示されます。

| 表情 | ゲーム動作 | 予備キー |
| --- | --- | --- |
| `happiness` / 喜び | ジャンプ | Space |
| `surprise` / 驚き | ブースト | S |
| `anger` / 怒り | 攻撃 | A |
| `sadness` / 悲しみ | シールド | D |
| `neutral` / 無表情 | 継続表情動作を解除 | — |

モデル読み込みやカメラ許可が失敗した場合は、エラー画面から再試行またはキーボードモードへ切り替えられます。

### キーボードモード

「キーボードモード」を選ぶと、`getUserMedia()` を呼び出さず、カメラの権限をリクエストしません。表情認識モジュールも動的importされないため、ONNXモデル、Face Landmarkerモデル、MediaPipe/ONNX RuntimeのWASMもダウンロードしません。

> 中文：选择键盘模式时，页面不会请求摄像头权限，不会加载表情识别模块、AI 模型或推理 WASM。

### 共通操作

- Space：ジャンプ
- S：ブースト
- A：攻撃
- D：シールド
- P：一時停止 / 再開
- M：ミュート / 解除
- RまたはEnter：ゲームオーバー後に再開
- Esc：メニューに戻る（フルスクリーン中はまず解除）

## AI推論とフォールバック / AI 推理与降级

Web版はブラウザ配布物に次の2つの学習済みモデルだけを含めます。Python版のYuNet、旧FERPlus、SSD/CaffeモデルはWeb配布物にコピーしません。

| ファイル | 用途 | ライセンス |
| --- | --- | --- |
| `enet_b0_8_best_vgaf.onnx` | EmotiEffLib/HSEmotionのAffectNet 8表情分類 | Apache License 2.0（`LICENSE-EMOTIEFFLIB.txt`） |
| `face_landmarker.task` | MediaPipe Face Landmarkerの顔検出、478点、52 blendshape | Apache License 2.0（`LICENSE-MEDIAPIPE.txt`） |

`model-manifest.json` に許可したファイルとSHA-256を固定し、`npm run prepare:assets` でリポジトリ直下の `models/` から `public/generated/` へコピーします。`npm run verify:models` は元ファイルと配布用コピーをSHA-256で照合します。`public/generated/` は生成物であり、直接編集しません。

ONNX Runtime WebはブラウザにWebGPUがある場合は `webgpu` execution providerを先に初期化します。WebGPUがない、またはモデル初期化に失敗した場合は、同じモデルを `wasm` execution providerで自動的に開き直します。ゲームのカメラパネルで使用中のバックエンドを確認できます。MediaPipeのGPU delegateがWorkerで作成できない場合はCPU delegateを使用します。

> 中文：Web 发布物只包含 EmotiEffLib ONNX 和 MediaPipe Face Landmarker 两个模型，两者均为 Apache-2.0。ONNX Runtime 优先使用 WebGPU，初始化失败时自动降级为 WASM。

## 必要環境 / 所需环境

- Node.js 24.x
- npm 11以上
- カメラモード：`getUserMedia`、Web Worker、ImageBitmap、Canvas/OffscreenCanvasに対応した現行ブラウザ
- カメラモード：HTTPS、または開発用 `localhost`
- キーボードモード：カメラ権限不要

`.nvmrc` はNode 24を指定しています。nvmを使用する場合：

```bash
cd web
nvm use
node --version
npm --version
```

## インストールと開発 / 安装与开发

`web/` はリポジトリ直下の2モデルとライセンスを参照するため、単独ではなくリポジトリ全体をcloneしてください。

```bash
git clone <repository-url>
cd IoT-AI-MP0/web
npm ci
npm run dev
```

`npm run dev` は先に `prepare:assets` を実行し、モデル、ライセンス、MediaPipe WASM、ONNX Runtime WASMを `public/generated/` に準備してからViteを起動します。ターミナルに表示される `http://localhost:5173/` を開いてください。

### カメラのHTTPS/localhost制限

`navigator.mediaDevices.getUserMedia()` は安全なコンテキスでのみ利用できます。

- 本番：`https://...` で配信します。
- 開発：`http://localhost:5173` または `http://127.0.0.1:...` を使用できます。
- `http://192.168.x.x:...` のようなLAN内HTTPは安全なコンテキスとみなされず、カメラAPIが無効になることがあります。
- 許可を拒否した場合は、ブラウザのURLバー付近にあるサイト設定からカメラ許可を変更し、ページを再読み込みしてください。
- カメラが他のアプリで使われている場合は、そのアプリを閉じてから再試行します。

> 中文：摄像头模式必须通过 HTTPS 或 localhost 运行。如果曾拒绝权限，请在浏览器的站点设置中重新允许摄像头并刷新页面。

## テストと検証 / 测试与验证

### 単体テスト

```bash
npm run test
```

Vitestでゲーム状態、固定シード、継続表情動作、ハイスコア/設定保存、表情前処理、顔位置合わせ、顔特徴、表情安定化を検証します。

### 総合チェック

```bash
npm run check
```

`check` は次を順に実行します。

1. モデル、ライセンス、MediaPipe/ONNX Runtimeランタイムの準備
2. モデルと生成物のSHA-256検証
3. TypeScript strict typecheck
4. ESLint
5. Vitest
6. Vite本番ビルド
7. 配布物のモデル、WASM、パス、不要ファイル、ローカル絶対パス、外部CDN参照の検査

### E2E

初回だけChromiumを準備します。

```bash
npx playwright install chromium
npm run test:e2e:dev
npm run build
npm run test:e2e
```

`test:e2e:dev` はVite開発サーバーでカメラ、ES Module Worker、MediaPipe、ONNXの完全な初期化を検査します。`test:e2e` は本番 `dist` のpreviewサーバーを自動起動し、次のフローを検査します。

- キーボードモードがカメラを要求せず、モデル/WASMをリクエストしないこと
- Space / S / A / D / P / Mの動作
- ハイスコアの再読み込み後の保持
- カメラ拒否時のキーボードフォールバック
- モデル読み込み失敗時の再試行/キーボードフォールバック
- 合成カメラでのWorker、MediaPipe、ONNXの完全な初期化と推論
- 実際のONNXモデルのWASM推論出力
- 本番配布物のモデル/WASMパス

## ビルドとpreview / 构建与预览

```bash
npm run build
npm run preview
```

`npm run build` は `web/dist/` を生成し、その後 `check:production` を実行します。`preview` は既存の `dist/` を配信するため、必ず先にbuildしてください。

特定のサブパス向けにビルドする場合：

```bash
VITE_BASE_PATH=/IoT-AI-MP0/ npm run build
VITE_BASE_PATH=/IoT-AI-MP0/ npm run preview
```

Pages用ビルドをローカル確認するときは、previewにも同じ`VITE_BASE_PATH`を渡し、表示された`/IoT-AI-MP0/`のURLを開いてください。

## GitHub Pages

`.github/workflows/deploy-web.yml` にGitHub Pagesのビルドとデプロイを定義しています。

1. GitHubのリポジトリで `Settings > Pages` を開きます。
2. `Build and deployment > Source` に `GitHub Actions` を選択します。
3. Web関連の変更を `main` にpushするか、Actionsからworkflowを手動実行します。
4. workflowはNode.js 24、`npm ci`、`npm run check`、`web/dist` のアップロード/デプロイを実行します。

現在のworkflowは `VITE_BASE_PATH=/IoT-AI-MP0/` を使用します。リポジトリ名を変えた場合はworkflowのパスも同時に更新してください。GitHub PagesはHTTPSで配信されるためカメラの安全なコンテキスト要件を満たします。

> 中文：工作流在 `main` 分支的 Web 相关文件更新时，使用 Node 24 执行 `npm ci` 和 `npm run check`，然后将 `web/dist` 发布到 GitHub Pages。请在 Pages 设置中选择 GitHub Actions。

## 既知の制限 / 已知限制

- 表示されるのは顔の外見上の表情分類であり、本人の内心や感情を断定するものではありません。
- 照明、逆光、顔の角度、マスクや髪による遮蔽、カメラ品質、個人差によって認識精度が変化します。
- WebGPUの有無、WASM速度、カメラ解像度、画面更新率はブラウザと端末に依存します。WASMモードやモバイルではAI FPSが低くなることがあります。
- カメラの `ideal` 解像度は必須値ではありません。実際の入力サイズは右上パネルに表示します。
- カメラのデバイスIDはブラウザの許可と端末によって変化することがあり、前回の選択が利用できない場合はデフォルトカメラまたは再選択が必要です。
- 初回は2つのモデルとWASMランタイムをダウンロードするため、通信速度と端末によって開始まで時間がかかります。通常はブラウザキャッシュが以後の読み込みを短縮します。
- 完全なオフライン実行は保証しません。このバージョンにはService Workerによるオフラインキャッシュはありません。
- iOS/Safari等では自動再生、カメラ、WebGPU、Workerの対応差があるため、まず現行のデスクトップChromium系ブラウザを推奨します。
- GitHub Pagesは静的ホスティングであり、サーバー側のAI、ユーザーアカウント、スコア同期は提供しません。

> 中文：识别结果只表示外观表情，不能判断人的内心。识别精度和帧率会受光线、姿态、遮挡、摄像头、浏览器和设备性能影响。首次需下载模型/WASM；当前版本没有 Service Worker，不保证完全离线运行。
