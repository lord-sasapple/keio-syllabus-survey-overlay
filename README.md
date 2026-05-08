# Syllabus Lens

Syllabus Lens は、慶應義塾大学のシラバス画面に K-Support の授業評価結果を表示する Chrome 拡張機能です。

ユーザーが K-Support で閲覧できる授業評価データをブラウザ内に保存し、シラバス一覧・詳細ページを開いたときに、総合満足度、回答率、設問別の評価、自由記述コメントを見やすく表示します。

一覧ページでは、画面に見えている授業と少し先の授業から順に評価を確認します。最初に全件をまとめて取得するのではなく、スクロールに合わせて必要な分だけ取得し、取得できたものから都度キャッシュします。

[![Image from Gyazo](https://i.gyazo.com/cf18666d60e6ec1f26a57e00e25ef39f.png)](https://gyazo.com/cf18666d60e6ec1f26a57e00e25ef39f)
このスクリーンショットの授業は架空のものですが、レビュー内容は実際の学生の声です。

## できること

- シラバス一覧に授業評価バッジを表示
- シラバス詳細ページに授業評価カードを表示
- 総合満足度を数字と星で表示
- 回答率・回答数を表示
- 各設問の回答分布を Google Maps の口コミ概要に近い横棒グラフで表示
- 「学修の負荷が大きすぎた」のような逆向き設問を、見やすい向きに補正して表示
- 自由記述コメントをポジティブ・改善要望・その他に分けて表示
- 教員プロフィールが見つかる場合、慶應義塾公式サイトへの外部リンクを表示
- シラバス一覧で見えている範囲と数画面分先の授業だけを順次取得
- 取得できた授業評価を都度キャッシュ
- 必要なときだけ K-Support へのログイン導線を表示

## できないこと・やらないこと

- 独自サーバーへのデータ送信はありません
- keio.jp / K-Support の ID・パスワードは取得しません
- Cookie や認証トークンは保存しません

## 対応サイト

この拡張機能は以下の慶應義塾大学関連サイトで動作します。

- `https://gslbs.keio.jp/syllabus/*`
- `https://gslbs.keio.jp/pub-syllabus/*`
- `https://keiouniversity.my.site.com/students/*`

## 使い方

1. Chrome の拡張機能画面で Syllabus Lens を開きます。
2. K-Support を開いてログインします。
3. シラバス一覧ページを開きます。
4. 画面に近い授業から順に、授業評価が自動で確認・保存されます。
5. 保存済みの授業評価は、次回以降すぐに表示されます。

## 表示内容

シラバス詳細ページでは、次の情報を表示します。

- 総合満足度
- 星評価
- 回答率
- 回答数
- 設問別の平均値
- 設問別の回答分布
- 自由記述コメント
- 教員プロフィールへのリンク

一覧ページでは、授業名の横に次のようなバッジを表示します。

- `★ 4.5 / 回答率 2.8%`
- `確認中`
- `公開評価なし`
- `ログインが必要`
- `確認できません`

## データ更新の仕組み

K-Support の授業評価検索ページを使い、シラバスに表示されている授業と対応する授業評価を確認します。

一覧ページでは、`IntersectionObserver` を使って、現在見えている授業と数画面分先の授業を取得キューに入れます。取得済み・取得中・公開評価なし確認済みの授業はスキップします。

取得は同時に数件までに制限し、成功した授業評価はその場でキャッシュします。ユーザーが見ていない遠い授業は、スクロールして近づくまで取得しません。

## データの保存場所

保存先はユーザーのブラウザ内だけです。

主に以下を保存します。

- 授業評価データ
- 自由記述コメント
- 公開評価なしを確認した授業
- 教員プロフィールのキャッシュ

外部サーバーへのアップロード、販売、共有は行いません。

## 権限

### `storage`

授業評価データ、自由記述コメント、公開評価なしを確認した授業をブラウザ内に保存するために使用します。

### `tabs`

ログイン済みの K-Support タブを探し、評価データを取得できる状態か確認するために使用します。また、必要に応じて K-Support の授業評価検索ページを開きます。

### `scripting`

K-Support ページに、拡張機能に同梱されたスクリプトを注入して、同一ページ内で授業評価 API を呼び出すために使用します。外部から取得したコードは実行しません。

### ホスト権限

慶應義塾大学のシラバス、K-Support、慶應義塾公式サイトの教員情報ページでのみ機能するために使用します。

## リモートコードについて

リモートコードは使用していません。

拡張機能が実行する JavaScript はすべて `extension/` 配下に含まれています。外部サイトから取得した JavaScript や Wasm を実行することはありません。

## 開発

このリポジトリは Manifest V3 の Chrome 拡張機能です。

GitHub から取得して使う手順:

```bash
git clone https://github.com/lord-sasapple/keio-syllabus-survey-overlay.git
cd keio-syllabus-survey-overlay
```

Chrome に読み込む手順:

1. Chrome で `chrome://extensions` を開きます。
2. 右上の「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」を押します。
4. clone したリポジトリ内の `extension/` ディレクトリを選択します。
5. Syllabus Lens のアイコンから K-Support を開いてログインします。
6. シラバス一覧を開きます。

更新する手順:

```bash
cd keio-syllabus-survey-overlay
git pull
```

更新後は `chrome://extensions` で Syllabus Lens の再読み込みボタンを押してください。

構文チェック:

```bash
node --check extension/popup/popup.js
node --check extension/src/shared.js
node --check extension/src/probe-bridge.js
node --check extension/src/ksupport-content.js
node --check extension/src/page-probe.js
node --check extension/src/syllabus-content.js
node --check extension/src/syllabus-result-content.js
node --check extension/background/service-worker.js
```

## 現在の制限

- K-Support にログインしていない状態では評価データを取得できません。
- K-Support 側の画面構造や Salesforce Aura API の仕様が変わると、取得処理の修正が必要になる可能性があります。
- 授業名・教員名・学期などが近い複数授業では、照合が難しい場合があります。
- 教員プロフィールは慶應義塾公式サイトの検索結果から見つかった場合のみ表示します。

## 方針

Syllabus Lens は、履修選択を助けるために、ユーザー本人が閲覧できる K-Support の授業評価をシラバス上で見やすく表示する拡張機能です。

授業評価を外部に再公開するサービスではありません。保存されたデータはユーザーのブラウザ内で利用されます。
