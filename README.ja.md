# Kabegame — プラグイン駆動のアニメ画像・動画コレクション／アーカイブツール

> *Translated by AI. [中文](README.md) | [English](README.en-US.md) | 日本語 | [한국어](README.ko.md)*

イラストサイト、コミュニティ、クリエイタープラットフォーム、ローカルフォルダに散らばった画像と動画を、一つのローカルライブラリに集約し、出典・タグ・作品メタデータをそのまま保持します。

Kabegame はダウンロードだけを担うツールではありません。プラグインがキャラクター・作品・絵師などのタグを自動で分類し、ローカルディレクトリは継続同期する画集にマッピングでき、ログインが必要な場合は内蔵ブラウザで一度ログインすればプラグインが保存済み Cookie を再利用できます。通常のサイトは軽量な V8 プラグインで処理し、JS レンダリングが重いサイトやアンチクロール対策のあるサイトは実ブラウザの WebView で収集できます。

<p align="center">
  <a href="https://github.com/kabegame/kabegame/releases/latest"><b>最新版をダウンロード</b></a>
  · <a href="https://demo.kabegame.com">オンライン体験</a>
  · <a href="https://kabegame.com/guide/quickstart/">クイックスタート</a>
  · <a href="https://github.com/kabegame/crawler-plugins">プラグインを見る</a>
  · <a href="https://kabegame.com/dev/overview/">プラグインを開発</a>
</p>

<p align="center">
  <a href="https://github.com/kabegame/kabegame/releases/latest">
    <img alt="最新リリース" src="https://img.shields.io/github/v/release/kabegame/kabegame?style=flat-square&sort=semver&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/releases">
    <img alt="累計ダウンロード数" src="https://img.shields.io/github/downloads/kabegame/kabegame/total?style=flat-square&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/stargazers">
    <img alt="GitHub Stars" src="https://img.shields.io/github/stars/kabegame/kabegame?style=flat-square&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/blob/main/LICENSE">
    <img alt="GPL-3.0 ライセンス" src="https://img.shields.io/github/license/kabegame/kabegame?style=flat-square" height="20"/>
  </a>
  <a href="https://kabegame.com">
    <img alt="プロジェクトドキュメント" src="https://img.shields.io/badge/docs-kabegame.com-2f80ed?style=flat-square" height="20"/>
  </a>
</p>

## 主なハイライト

- **タグの自動分類**：対応プラグインはダウンロード時にキャラクター、作品、絵師、モデル、出典などの構造化タグを同時に書き込み、閲覧と組み合わせフィルタができるタグディレクトリを自動で形成します。収集後に一枚ずつ整理する必要はありません。
- **ローカルフォルダの継続同期**：ディスク上のディレクトリを同期画集にマッピングし、ディレクトリ内の追加・削除がライブラリに反映され、サブディレクトリは元の階層のまま子画集を生成できます。お絵かきソフト、AI 画像生成ツール、その他のダウンローダーの出力を受け取り続けるのに向いています。
- **一度ログインすれば以後は自動再利用**：「ブラウジング（暢遊）」の内蔵ブラウザで普通にサイトへログインすると、Kabegame がすべてのサイト Cookie を保存します。プラグインはホストから安全にログイン状態を注入でき、Cookie を何度もコピーする必要がなく、Cookie の平文を読むこともありません。
- **ブラウジングから動画をそのまま保存**：内蔵ブラウザで動画を右クリックして「動画をダウンロード」を選ぶと、`blob:` / MSE のストリーミングプレーヤーでも画質ごとに音声・映像の断片を取り込み、結合してライブラリに追加します。右下に各ストリームの取り込み進捗がリアルタイムで表示されます。
- **実 WebView 駆動のクロール**：軽量な V8 HTTP / HTML プラグインに加え、プラグインを実際のブラウザページ内で実行し、SPA、JS レンダリング、ブラウザフィンガープリント、Cloudflare チェック、操作が必要なログインフローに対応できます。
- **スクリプトで新しいコンテンツソースを拡張**：クローラープラグインは JavaScript / TypeScript で書けるため、Kabegame 本体を変更・再コンパイルする必要はありません。一つのプラグインが収集ロジック、設定フォーム、タグ分類、出典メタデータ、詳細ビューを同時に定義でき、`.kgpg` ファイルにパッケージして他のユーザーと共有できます。
- **出典情報を画像と一緒に残す**：プラグインは作者、元投稿リンク、本文、コメント、コミュニティタグ、AI 生成パラメータを保存し、独自の詳細ビューと検索断片を提供できます。画像が元サイトを離れても「どこから来て、なぜ保存したのか」が分かります。

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/auto-labels.jpg" alt="Kabegame タグの自動分類" width="100%"/><br/>
      <small>プラグインが構造化タグを書き込み、絞り込めるタグディレクトリを自動で形成</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/folder-sync.jpg" alt="Kabegame ローカルフォルダ同期" width="100%"/><br/>
      <small>ローカルディレクトリを、階層を保ったまま継続同期する画集にマッピング</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/cookie-reuse.jpg" alt="Kabegame が Cookie を自動保存して再利用" width="100%"/><br/>
      <small>ブラウジングで一度ログインすれば、以後の収集はログイン状態を自動再利用</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/source-metadata.jpg" alt="Kabegame 出典メタデータ" width="100%"/><br/>
      <small>作者、元投稿、タグ、インタラクション情報を画像と一緒に保持</small>
    </td>
  </tr>
</table>

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/webview-crawler-images.jpg" alt="Kabegame WebView クローラーの収集結果" width="100%"/><br/>
      <small>プラグインは実際のブラウザページで動作し、メディアを収集タスクへ渡します</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/webview-crawler-log.jpg" alt="Kabegame WebView クローラーのタスクログ" width="100%"/><br/>
      <small>ページ操作、スクロール、抽出の過程をタスクログで追跡できます</small>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="docs/images/features/surf-video-download.jpg" alt="Kabegame ブラウジングの動画ダウンロードと取り込み進捗" width="100%"/><br/>
      <small>ブラウジングでストリーミング動画を右クリックで保存し、右下に各ストリームの取り込み進捗を表示</small>
    </td>
  </tr>
</table>

## 収集からアーカイブまで

- **統合収集**：プラグインを通じて Pixiv、Bilibili、Danbooru、壁紙サイト、コミュニティなどからまとめて取得でき、内蔵ブラウザで見ながら収集もできます。
- **統合検索**：異なるソースが同じギャラリーに入り、時間、プラグイン、タグ、メディア種別、サイズ、ファイルサイズ、メタデータ検索の組み合わせで絞り込めます。
- **統合管理**：通常の画集でテーマを手動整理し、タグディレクトリで自動分類し、同期画集でディスクフォルダを追従し、重複排除と非表示で長期間蓄積したライブラリを扱えます。
- **ローカル所有**：元ファイルとライブラリデータはあなたの手元にあります。ダウンロード先をカスタマイズでき、仮想ディスク経由で他のアプリから画集にアクセスできます。
- **拡張し続ける**：クローラープラグインは JavaScript / TypeScript で書けます。MCP を使えば AI エージェントが明確な権限のもとでライブラリを検索・整理できます。

Kabegame が解こうとしているのは「画像をどうダウンロードするか」ではなく、画像が異なるソースをまたいで積み上がっていく中で、どう文脈を保ち長期的に整理するかです。画像整理からあなたの手を解放し、AI 学習者、二次元ファン、そして仕事中の息抜きに最適です。png などの画像はメタデータを解析できるので、AI 生成画像のプロンプトが見つかるかもしれません！（私自身、いくつものワークフローを Kabegame から拾いました）

## クイックスタート

1. [GitHub Releases](https://github.com/kabegame/kabegame/releases/latest) から Kabegame をダウンロードしてインストールします。
2. 「ソース」を開き、公式プラグインディレクトリから興味のあるプラグインをインストールします。ローカル画像の管理だけならこの手順は飛ばせます。
3. 「ギャラリー」に戻り、「収集を開始」をクリックして、ローカルインポートまたはネットワークプラグインを選びます。
4. ギャラリーで出典とタグにより絞り込み、元投稿のメタデータを確認し、長期保存したいものを画集に整理します。

5 分でわかる一連の流れは[クイックスタート](https://kabegame.com/guide/quickstart/)を参照してください。デスクトップアプリをインストールしなくても、[オンライン Demo](https://demo.kabegame.com) でライブラリ画面を試せます。

## 主な機能

| 機能 | 説明 |
| --- | --- |
| プラグイン駆動の収集 | 内蔵プラグインストアで `.kgpg` プラグインをインストール・更新・管理できます。V8 と WebView のバックエンドが、それぞれ軽量リクエストと実ブラウザのシナリオをカバーします。 |
| ログイン状態の再利用 | ブラウジングがサイト Cookie を保存し、V8 プラグインは安全に注入を要求できます。WebView プラグインはブラウザセッションを直接利用します。 |
| タグとメタデータ | プラグインはタグを自動分類し、元投稿、作者、コメント、生成パラメータを保存し、詳細ビューと検索フィールドを提供できます。 |
| ギャラリーと検索 | 画像と動画を閲覧し、時間、出典、タグ、メディア、サイズ、ファイルサイズ、メタデータの組み合わせで絞り込めます。 |
| 画集とフォルダ | 手動画集は多階層の整理に対応し、同期画集はローカルディレクトリとそのサブディレクトリの変化を継続的に追従します。 |
| ローカルライブラリ連携 | ダウンロード先のカスタマイズ、ドラッグ＆ドロップでのインポート、一括操作、重複排除、仮想ディスク、ネイティブメタデータの読み取り。 |
| 自動化とオープンインターフェース | 定時収集、CLI、MCP に対応。壁紙設定と画集ローテーションはデスクトップ版の追加機能として提供します。 |

## プラグインエコシステム

公式プラグインリポジトリは、すでに二十以上のイラストサイト、コミュニティ、クリエイタープラットフォーム、壁紙サイトをカバーしています。プラグインごとに独自の設定フォーム、ログイン方法、タグ軸、詳細表示、おすすめタスクを提供できます。

- **プラグインを使う**：[公式プラグインディレクトリを見る](https://github.com/kabegame/crawler-plugins) · [プラグインのインストールと管理](https://kabegame.com/guide/plugins-usage/)
- **プラグインを開発する**：[開発概要](https://kabegame.com/dev/overview/) · [V8 / WebView バックエンドの選択](https://kabegame.com/dev/crawler-backends/) · [API リファレンス](https://kabegame.com/reference/kabegame-api/)
- **プラグインを貢献する**：新しいソースの追加、壊れたサイトの修正、既存プラグインのドキュメントやメタデータの改善ができます。

V8 プラグインは自己完結した ES Module で、HTTP リクエスト、API、HTML 解析による収集に適しており、Android でも動作します。実ブラウザのレンダリング、ブラウザセッション、ページ操作に依存する必要がある場合は、デスクトップ版の WebView バックエンドを使えます。ページを実際に動かしたうえで、DOM、ネットワーク応答、ページのダウンロードから内容を抽出します。

> プラグインは、あなたがアクセスする権利を持つ内容の整理にのみ使用してください。ソースサイトの利用規約を守り、作者の著作権とプライバシーを尊重し、アクセス頻度を適切に抑えてください。

## ダウンロードとプラットフォーム

現在の主要リリースはデスクトップ版です。`kabegame-cli` は独立した任意のツールで、本体と一緒にはインストールされません。

| プラットフォーム | ダウンロードファイル | 説明 |
| --- | --- | --- |
| Windows x64 | `Kabegame-standard_<バージョン>_x64-setup.exe` | ダブルクリックでインストールします。画集仮想ディスクには Dokan 2.x が必要で、初回有効時にアプリがインストールを促します。 |
| macOS Apple シリコン | `Kabegame-standard_<バージョン>_aarch64.dmg` | macOS 11 以降に対応。インストーラーはまだ署名されていません。 |
| Linux amd64 | `Kabegame-standard_<バージョン>_amd64.deb` | `apt` でインストールします。画集仮想ディスクは `fuse3` に依存します。 |
| Android | `Kabegame_<バージョン>_android-preview.apk` | Android 8.0 以降。現時点では v4.3.0 を使用してください。以降のバージョンは現在対応中です。 |

macOS の初回起動で開発元を検証できない、またはアプリが壊れていると表示された場合：

```bash
xattr -d com.apple.quarantine /Applications/Kabegame.app
```

macOS で画集仮想ディスクを使う場合は、macFUSE もインストールします：

```bash
brew install --cask macfuse
```

Linux へのインストール：

```bash
sudo apt install ./Kabegame-standard_*_amd64.deb
```

画像はデフォルトでユーザーのピクチャディレクトリの `Pictures/Kabegame` に保存され、アプリをアンインストールしてもここにある画像は削除されません。より詳しいプラットフォーム要件、データディレクトリ、トラブルシューティングは[インストールドキュメント](https://kabegame.com/guide/installation/)を参照してください。

## プロジェクトに参加する

Tauri / Rust のモノレポ全体を先に理解していなくても、Kabegame に参加できます：

- 問題が発生したら [Bug report](https://github.com/kabegame/kabegame/issues/new?template=bug_report.md) を提出してください。
- 新しいソースに対応してほしい場合は、[プラグインリポジトリ](https://github.com/kabegame/crawler-plugins)でプラグインを提出するか要望を出してください。
- アプリ本体を改善したい場合は、まず[ソースからのビルド](https://kabegame.com/dev-contrib/building/)と[アーキテクチャ](https://kabegame.com/dev-contrib/architecture/)をお読みください。
- ドキュメント、翻訳、スクリーンショット、プラグイン説明も同じく価値のある貢献です。

Kabegame が役に立ったら、Star を付けていただけると嬉しいです。より多くのユーザーと潜在的なプラグイン作者にプロジェクトを知ってもらう助けになり、私にとっても励みになります。

## 技術的なハイライト

Kabegame は Vue 3、Tauri 2、Rust で構築され、ライブラリクエリ、プラグインランタイム、デスクトップブラウザ機能についていくつかの拡張を行っています：

- [WebviewHandler](./src-tauri/kabegame-core/src/crawler/webview.rs)：ログイン状態やページ操作を必要とするプラグインを実ページ環境で実行します。
- [tauri-runtime-cef](./src-tauri/tauri-runtime-cef/)：デスクトップ向けにカスタマイズした CEF Tauri runtime。
- [PathQL](./src-tauri/pathql-rs/)：パスによる組み合わせフィルタ、並べ替え、ページングと Provider DSL を備えたデータベースクエリエンジン。

プロジェクト構成、プロセスモデル、主要モジュールは[アーキテクチャとプロジェクト構成](https://kabegame.com/dev-contrib/architecture/)を参照してください。

## ライセンス

Kabegame は [GPL-3.0](./LICENSE) でオープンソース化されています。

## 名前の由来 🐢

**Kabegame** は日本語の「壁亀」（かべがめ）のローマ字表記で、「壁紙」（かべがみ）と発音が近いんです。まるで静かな亀さんがデスクトップに乗って、あなたの画像コレクションを見守っているかのよう。
