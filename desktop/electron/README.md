# Emotion Runner Electron

既存の Web 版を Chromium ウィンドウで動かす追加のデスクトップ版です。Python/Pygame 版を削除・置換せず、同じゲーム UI・操作・音声・モデルを `web/` から再利用します。

> 中文：这是新增的 Electron 桌面版，不替换 Python App。游戏逻辑和日文界面复用现有 Web 版，运行时不需要 Python、Node.js 或线上网站。

## 開発起動 / 开发运行

Node.js 24 と npm 11 以降が必要です。リポジトリ直下から実行します。初回の依存・Electron ダウンロードには通信が必要ですが、配布したアプリのゲーム・AI はローカルで動作します。

```sh
npm --prefix web ci
npm --prefix desktop/electron ci
npm --prefix desktop/electron start
```

`start` は Web の本番ビルドとモデルの SHA-256 検査を実施し、静的配布物だけを `desktop/electron/web/` へコピーして起動します。Pages 用の `VITE_BASE_PATH` はデスクトップビルドでは `/` に固定します。ビルド済みの内容をもう一度開くだけなら `npm --prefix desktop/electron run start:built` を使用します。

## アプリ作成 / 应用打包

```sh
# macOS Apple Silicon: Finder で開く .app / 可直接打开的本地应用
npm --prefix desktop/electron run pack:mac

# macOS: ローカル検証用 DMG + ZIP / 本地测试安装包
npm --prefix desktop/electron run dist:mac

# Windows x64: Windows 上で実行 / 请在 Windows 上构建
npm --prefix desktop/electron run dist:win
```

出力は `desktop/electron/release/` です。Mac の `.app` は `release/mac-arm64/Emotion Runner Electron.app` に作成されます。Python 版の `dist/Emotion Runner.app`、Python ソース、仮想環境、最高得点には触れません。

アプリアイコンは Web の `favicon.svg` と同じ笑顔を使用します。`packaging/icon.icns`（macOS）、`icon.ico`（Windows、16〜256 px）、`icon.png`（1024 px）を同梱し、通常のビルドでは変換ツールの追加インストールは不要です。元 SVG を変更したときは macOS と `rsvg-convert` のある環境で `npm --prefix desktop/electron run icons:prepare` を実行してください。 / 应用图标与网页笑脸保持一致；修改 SVG 后可用此命令重新生成，普通打包直接使用已生成的图标。

Mac の上記コマンドは ad-hoc 署名のローカル検証版で、Developer ID 署名・公証は行いません。この検証版だけ Hardened Runtime を無効にしています（Chromium のサンドボックス・context isolation・Web security は有効）。第三者へ配布する際は Developer ID と公証環境を別途用意し、`electron-builder.yml` の Hardened Runtime を有効にした通常ビルドで署名・公証を行ってください。証明書や認証情報を Git に保存しないでください。

> 中文：本地 Mac 包未公证，不代表可以无提示地分发给其他用户。Windows 构建配置已提供，但 macOS 上的测试不能代替 Windows 实机验证。初版不发布自动更新，也不自动上传 Release 或 Site。

## データとカメラ / 数据与摄像头

- アプリ名・ID：`Emotion Runner Electron` / `io.github.kai987.emotionrunner.electron`。
- Mac の保存先：`~/Library/Application Support/Emotion Runner Electron/`。
- Windows の保存先：`%APPDATA%/Emotion Runner Electron/`。
- 得点・設定はこのアプリ専用の Chromium `localStorage` に保存します。ブラウザ版や Python 版から自動移行しません。
- `desktop.log` はアプリ起動・失敗だけを記録し、約 1 MiB ごとに 1 世代保持します。画像・動画・表情履歴を保存・送信しません。
- カメラは「カメラモード」など利用者が選択したときだけ要求します。「キーボードモード」では起動しません。
- macOS で拒否した場合は「システム設定 → プライバシーとセキュリティ → カメラ」でこのアプリを許可してください。Python 版の許可とは別です。
- アプリウィンドウを閉じるとプロセスも終了します。メニューへ戻ると Web 版の停止処理でカメラと Worker を解放します。

## 実装方針 / 实现与权限边界

`emotion-runner://app/` の専用安全プロトコルで、同梱した HTML / JS / WASM / ONNX / MediaPipe モデルを読み込みます。外部サイトやローカル HTTP サーバーは使いません。

- renderer は `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`。Node/Electron API の preload ブリッジもありません。
- カメラ映像と全画面だけを信頼済みメイン画面に許可します。マイク、画面収録、位置情報、外部ナビゲーション、ポップアップ、ダウンロードは許可しません。
- CSP、配布フォルダー内のパス検証、正しい MIME、Range / HEAD 対応でモデルをローカル配信します。Web の Worker・WebGPU → WASM フォールバックをそのまま使用します。
- MediaPipe が終了時などに外部ログ送信を試みる場合も、CSP と Electron の通信ポリシーで遮断します。検証時の遮断メッセージはモデル初期化の失敗とは区別します。 / MediaPipe 可能尝试发送诊断日志，但会被应用的外部通信策略阻止；拦截提示不等于模型加载失败。
- Web 版のモデルは 2 つ（MediaPipe Face Landmarker と EmotiEffLib ONNX）。Python 版の YuNet/OpenCV パイプラインへ置き換えるものではありません。
- 同梱ライセンスは `web/generated/models/` に含まれます。レポート、個人画像、Notebook、Python ランタイムは同梱対象外です。

## テスト / 验证

```sh
npm --prefix desktop/electron test
npm --prefix desktop/electron run build
npm --prefix desktop/electron run test:smoke

# 打包后的应用也执行同一套测试 / 同梱後も同じ検証を実施
npm --prefix desktop/electron run test:smoke -- --executable "/absolute/path/Emotion Runner Electron.app/Contents/MacOS/Emotion Runner Electron"

# 証拠を指定フォルダーへ保存 / 将诊断保存到指定目录，不覆盖以往测试
npm --prefix desktop/electron run test:smoke -- --evidence-dir "/tmp/emotion-runner-evidence" --evidence-label development
```

smoke テストは一時データディレクトリと Chromium の合成カメラを強制し、実カメラを開きません。メニュー・キーボード操作・全画面・設定保存・モデル初期化・カメラ停止・セキュリティ境界を検査します。結果・スクリーンショット・Electron の標準出力/エラー・`desktop.log` は、終了処理後に成功/失敗どちらでも保存します。既定では OS の一時ディレクトリ、`--evidence-dir` または `EMOTION_RUNNER_SMOKE_EVIDENCE_DIR` を指定するとその配下に実行ごとの固有フォルダーを作ります。CLI の指定が環境変数より優先され、開発版/同梱版は別フォルダーになります。**合成カメラの成功は、本人の表情認識精度や実機のカメラ権限を確認したことにはなりません。**

手動確認では、カメラ許可/拒否、各表情、Mac 内蔵カメラの選択、再接続、終了後のカメラランプ消灯を確認してください。

`.github/workflows/check-electron.yml` は次の範囲で自動検証します（自動公開なし）。

- `main` / `codex/electron-*` への関連ファイルの push：Linux で Web のモデル検証・TypeScript・ESLint・単体テスト・ビルド、および Electron ポリシー/診断ヘルパーの単体テスト。
- 関連ファイルの PR、および手動実行：上記に加え、macOS ARM64 / Windows x64 で開発版と同梱版の合成カメラ smoke、未署名/ローカル検証用パッケージを作成。成功時に ZIP、失敗時を含めて診断ファイルを保存（7 日）。ユーザーデータディレクトリ自体はアップロードしません。

> 中文：普通推送只跑快速检查；PR 或手动执行才追加 Mac/Windows 打包与合成摄像头测试，控制运行成本。CI 中的 Windows `win-unpacked` 测试不等于 NSIS 安装、升级、卸载或真实摄像头已通过验证；Mac 本地验证包也不代表已完成 Developer ID 签名和公证。

参考： [Electron セキュリティ](https://www.electronjs.org/docs/latest/tutorial/security) / [安全プロトコル](https://www.electronjs.org/docs/latest/api/protocol) / [macOS 配布](https://www.electron.build/v26/docs/mac/)
