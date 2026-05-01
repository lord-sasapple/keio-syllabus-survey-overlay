# 慶應アンケート結果画面 解析メモ

調査日: 2026-05-01

## 目的

慶應のシラバス画面に、その授業のアンケート結果を重ねて表示する Chrome 拡張を作るため、まずアンケート結果画面から取得できる情報と、シラバス詳細画面との紐付け方法を整理する。

## 参照した公式情報

- 本命の K-Support 授業評価検索画面
  - https://keiouniversity.my.site.com/students/s/ClassEvaluationSearch
- 慶應義塾日吉情報センター: 回答状況一覧/集計結果
  - https://www.hc.itc.keio.ac.jp/ja/keiojp_edu2_faculty_questionnaire_response.html
- 慶應義塾ITC: アンケート（回答状況の確認）
  - https://www.itc.keio.ac.jp/ja/keiojp_edu_student_questionnaire_check.html
- 慶應義塾大学塾生サイト: 授業評価アンケート
  - https://www.students.keio.ac.jp/sk/pha/class/registration/evaluation.html
- シラバス詳細サンプル
  - https://gslbs.keio.jp/pub-syllabus/detail?entno=33239&lang=jp&ttblyr=2025

## 現時点の重要な前提

- `https://keiouniversity.my.site.com/students/s/ClassEvaluationSearch` は、未ログイン状態では Salesforce の SAML 認証要求へ JavaScript リダイレクトされる。
  - リダイレクト先: `/students/saml/authn-request.jsp`
  - `RelayState`: `/students/s/ClassEvaluationSearch`
  - つまり、ログイン後に K-Support 内の授業評価検索画面へ戻る構造。
- レスポンスヘッダ上は `server: sfdcedge` で、Salesforce Experience Cloud 上のページと見てよい。
- 公開マニュアルに載っている「コンテンツ回答結果集計」画面は、旧授業支援/K-LMS 系の画面で、スクリーンショット上は 2017 年のサンプル。
- 2026 年現在の全学共通 KSEI 授業評価アンケートは K-Support（`keiouniversity.my.site.com`、keio.jp 認証必須）から回答する案内になっている。
- そのため、実装前に本物の「アンケート結果画面」の HTML を 1 件確認する必要がある。公開情報だけでは、現在の K-Support 結果画面の DOM は確定できない。

## 本命 URL の認証前挙動

未ログインで `ClassEvaluationSearch` にアクセスすると、返ってくる HTML は実画面ではなく、次のようなリダイレクト専用ページになる。

```html
<script>
function redirectOnLoad() {
  var url = '/students/saml/authn-request.jsp?...&RelayState=%2Fstudents%2Fs%2FClassEvaluationSearch';
  window.location.replace(url);
}
redirectOnLoad();
</script>
```

この段階では授業評価検索画面の DOM、コンポーネント名、API 通信先は取得できない。ログイン済みブラウザ上での解析が必要。

## ログイン後の K-Support 授業評価画面

ログイン後、`ClassEvaluationSearch` は次の検索画面として表示される。

- ページタイトル: `授業評価結果`
- 見出し: `授業評価結果 科目検索 Search for Class Evaluation Results`
- 説明文: 回答のあった科目のみ表示、科目名クリックで授業評価結果画面へ遷移
- 検索条件
  - `科目名 Course Name`
  - `キャンパス Campus`
  - `主担当者 Main Lecturer`
  - `学部 Faculty`
  - `学期 Semester`
- 結果グリッド
  - `科目名 Course Name`
  - `主担当者 Main Lecturer`
  - `学期 Semester`
  - `曜日時限 Day/Period`
  - `キャンパス Campus`
  - `学部 Faculty`

検索画面の科目リンクは、直接は次のような Salesforce レコード URL を持つ。

```text
https://keiouniversity.my.site.com/students/a0AfR000002LwFr
```

この URL を開くと、最終的に次の形式へ正規化される。

```text
https://keiouniversity.my.site.com/students/s/course-offering-schedule/{courseOfferingScheduleId}/csh163408
```

例:

```text
https://keiouniversity.my.site.com/students/s/course-offering-schedule/a0AfR000002LwFr/csh163408
```

ここで `a0AfR000002LwFr` は科目/開講スケジュール系の Salesforce レコード ID と見られる。`csh163408` はこの詳細ページ種別またはレイアウト/コンテンツ識別子のように見える。

## 授業評価結果ページの表示構造

結果ページのページタイトル:

```text
授業評価: 計算機システム論
```

表示される主なデータ:

- `授業評価集計結果`
- `授業情報 / Class Information`
  - `科目名 Course Name`
  - `主担当者 Main Lecturer`
  - `学期 Semester`
  - `曜日時限 Day/Period`
  - `キャンパス Campus`
  - `学部 Faculty`
  - `回答率`
- 5 段階評価の凡例
  - `①そう思わない`
  - `②あまりそう思わない`
  - `③どちらともいえない`
  - `④ややそう思う`
  - `⑤そう思う`
- 各設問のドーナツチャート
  - 例: `Q1 この授業に積極的に参加した`
  - 例: `Q2 授業の内容を十分に理解できた`
  - `平均: 5.00` のような平均値
  - `⑤100.0%`、`④75.0%` のような選択肢別割合
- 自由記述
  - `この授業で良かったと思う点をお書きください。What were the positive aspects of the course?`
  - `この授業で改善してほしいと思う点をお書きください。Please record any course improvement suggestions.`
  - `その他、科目に関するご意見・ご感想など自由にお書きください。Please let us know if you have any requests or opinions.`
- 教員コメント
  - `授業評価_教員コメント`

初期実装では、自由記述と教員コメントは保存しない方がよい。集計値だけでもシラバス重ね表示の価値は十分ある。

## ログイン後に確認できたリソース/API 入口

ページは Salesforce Aura/Experience Cloud として動作している。

主要な読み込みリソース:

```text
/students/s/sfsites/auraFW/javascript/{fwuid}/aura_prod.js
/students/s/sfsites/l/{encoded Aura context}/app.js?3=...
/students/s/sfsites/l/{encoded Aura context}/resources.js?pv=...&rv=...
/students/s/sfsites/l/{encoded Aura context}/bootstrap.js?aura.attributes=...&jwt=...
```

重要:

- `bootstrap.js` のクエリには `jwt` が含まれるため、ログや保存対象にしてはいけない。
- `app.js` は約 4.6MB の Salesforce 共通バンドルで、慶應固有のラベル文字列は見つからなかった。
- `app.js` 内には Salesforce Education Cloud 系と思われる Aura server action が含まれていた。

確認できた関連候補:

```text
aura://AdvancedAcademicOperationsConnectController/ACTION$getCourseOfferingDetails
parameter: courseOfferingId
return: CourseOfferingDetailResponseRepresentation
```

これは `授業情報 / Class Information` の取得に使われている可能性がある。ただし、授業評価の集計値そのものを返す API かは未確定。

現時点で推定される最小データ取得戦略:

1. `ClassEvaluationSearch` の検索結果グリッドから `courseOfferingScheduleId` と科目メタデータを取得する。
2. 詳細ページ URL `/students/s/course-offering-schedule/{id}/csh163408` を開く。
3. 詳細ページの DOM から評価集計値を抽出する。
4. Network API が確定できれば、DOM を経由せず Aura action を直接呼ぶ方式に切り替える。

現時点では 4 は未確定。

## 2026-05-01 実測で確定した Aura API

ログイン済み Chrome タブ上で Human Browser Bridge とページ内 probe を使い、検索結果と評価詳細の実 Network request を確認できた。

重要な注意:

- Salesforce の `bootstrap.js` に付いている `jwt` だけでは直接 API 呼び出しには足りない。
- 実際の Aura POST には `aura.token` が必要。この値はログイン済みページが送る Aura request body に入る。
- `aura.token`、Cookie、`jwt` は拡張やログに保存しない。拡張はページ内で短時間だけ使い、保存対象は集計値に限定する。
- `/services/data/.../ui-api/records/...` のような Salesforce REST UI API は `API_DISABLED_FOR_ORG` で 403 になったため、REST API ではなく Aura endpoint を使う。

### 検索 API

検索結果は次の Aura endpoint で返る。

```text
POST https://keiouniversity.my.site.com/students/s/sfsites/aura?r=<number>&aura.ApexAction.execute=1
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

form body の主要フィールド:

```text
message=<JSON>
aura.context=<JSON>
aura.pageURI=/students/s/ClassEvaluationSearch
aura.token=<ログイン済みページ由来の Aura token>
```

`message` の action:

```json
{
  "actions": [
    {
      "descriptor": "aura://ApexActionController/ACTION$execute",
      "callingDescriptor": "UNKNOWN",
      "params": {
        "namespace": "",
        "classname": "Sp_CourseEvaluationSearchController",
        "method": "searchCourses",
        "params": {
          "criteria": {
            "courseName": "",
            "mainLecturer": "",
            "semester": "",
            "campus": "",
            "faculty": ""
          },
          "pageNumber": 1,
          "checkMaxRecords": false
        },
        "cacheable": false,
        "isContinuation": false
      }
    }
  ]
}
```

`checkMaxRecords: true` の初回 request は `totalCount` と `pageSize` の確認用で、レコード本体は返さない。`checkMaxRecords: false` にすると検索結果レコードが返る。

検索結果 1 件の例:

```json
{
  "Id": "a0AfR000002LwFrUAK",
  "SubjectNm_Link__c": "<a href=\"https://keiouniversity.my.site.com/students/a0AfR000002LwFr\" target=\"_blank\">計算機システム論</a>",
  "Display_Faculty_JaEng__c": "田中 公隆",
  "Display_Term_JaEng__c": "2025年秋学期",
  "wdcol_JaEng__c": "土３",
  "CampusJaEng__c": "矢上",
  "Department_JaEng__c": "理工学部"
}
```

シラバス照合に使えるキーは、科目名、主担当者、学期、曜日時限、キャンパス、学部。詳細ページ URL に使う ID はリンク内の 15 桁 ID `a0AfR000002LwFr` でよい。

### 評価集計 API

詳細ページのドーナツチャートは、LWC `c-class-evaluation-graph2` が `lightning/uiRecordApi.getRecord` 相当の Aura request で取得している。

endpoint:

```text
POST https://keiouniversity.my.site.com/students/s/sfsites/aura?r=<number>&ui-force-components-controllers-recordGlobalValueProvider.RecordGvp.getRecord=1
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

action descriptor:

```text
serviceComponent://ui.force.components.controllers.recordGlobalValueProvider.RecordGvpController/ACTION$getRecord
```

`message` の params は `recordDescriptor` が中心。

```text
{recordId}.null.null.null.null.{commaSeparatedFieldList}.VIEW.true.{timestampOrGuid}.null.null
```

例:

```text
a0AfR000002LwFr.null.null.null.null.SubjectNm_JaEng__c,Display_Faculty_JaEng__c,Display_Term_JaEng__c,wdcol_JaEng__c,CampusJaEng__c,Department_JaEng__c,Sp_CeAnsPercent__c,Sp_CeFacComment__c,Sp_CeCntQ1_1__c,...,Sp_CeQ7_en__c.VIEW.true.1777621269368.null.null
```

response は少し特殊で、`actions[0].returnValue` は `null` でも、実データは `context.globalValueProviders` の `$Record` に入る。

```text
context.globalValueProviders[]
  -> type === "$Record"
  -> values.records[<18-char-id>].hed__Course_Offering_Schedule__c.record.fields
```

`c-class-evaluation-graph2` が要求する評価フィールド:

```text
Sp_CeCntQ1_1__c ... Sp_CeCntQ7_5__c
Sp_CeAvgQ1__c ... Sp_CeAvgQ7__c
Sp_CeQ1_ja__c ... Sp_CeQ7_ja__c
Sp_CeQ1_en__c ... Sp_CeQ7_en__c
```

授業情報として一緒に取ると便利なフィールド:

```text
SubjectNm_JaEng__c
Display_Faculty_JaEng__c
Display_Term_JaEng__c
wdcol_JaEng__c
CampusJaEng__c
Department_JaEng__c
Sp_CeAnsPercent__c
```

サンプル `a0AfR000002LwFr` では、Q1-Q7 の平均値と 5 段階回答数を全て取得できた。例:

```json
{
  "courseName": "計算機システム論",
  "lecturer": "田中 公隆",
  "semester": "2025年秋学期",
  "dayPeriod": "土３",
  "campus": "矢上",
  "faculty": "理工学部",
  "answerPercent": 22.22,
  "questions": [
    {
      "index": 1,
      "ja": "Q1 この授業に積極的に参加した",
      "avg": 5,
      "counts": [0, 0, 0, 0, 4]
    },
    {
      "index": 7,
      "ja": "Q7 全体として、この授業に満足している",
      "avg": 5,
      "counts": [0, 0, 0, 0, 4]
    }
  ]
}
```

### 自由記述コメント

自由記述は Flow `Sp_CeCommentList` で描画されている。

確認できた Aura endpoint:

```text
POST /students/s/sfsites/aura?r=<number>&aura.FlowRuntimeConnect.startFlow=1
```

action descriptor:

```text
aura://FlowRuntimeConnectController/ACTION$startFlow
```

ただし、初期 MVP では自由記述は保存・表示しない。匿名コメントや個人情報に近い内容を含む可能性があり、シラバス重ね表示の価値は集計値だけでも成立する。

### 拡張の実装方針更新

直接 API 型に寄せる場合の最小構成:

1. K-Support のログイン済みタブで `aura.token` と `aura.context` が有効な状態を作る。
2. `Sp_CourseEvaluationSearchController.searchCourses` でシラバスの科目情報に近い検索を行い、`courseOfferingScheduleId` を得る。
3. `RecordGvp.getRecord` に評価フィールド一覧を渡して、Q1-Q7 の平均値・回答数・回答率を取る。
4. `chrome.storage.local` へ保存するのは、科目メタデータと集計値だけにする。
5. シラバス画面側 content script が、正規化した科目名・教員名・学期・曜日時限で保存済み評価を照合して表示する。

シラバス画面だけを開いた状態で完全自動取得するには、裏側にログイン済み K-Support context が必要。拡張だけで完結させるなら、K-Support タブを開く、または既存 K-Support タブを使って Aura request を送る background/content-script ブリッジを作る。

## 拡張実装の到達点

2026-05-01 時点で、次の形まで実装した。

```text
シラバス content script
  -> background service worker
    -> ログイン済み K-Support tab を検索
      -> K-Support content script
        -> page-world probe
          -> Aura searchCourses
          -> Aura RecordGvp.getRecord
```

実装ファイル:

- `extension/background/service-worker.js`
  - K-Support タブ検出
  - シラバス側からの取得依頼を K-Support タブへ中継
  - K-Support 未検出時のログイン画面オープン
- `extension/src/page-probe.js`
  - ページ本体コンテキストで Aura token / context を一時利用
  - 検索 API と評価詳細 API を実行
  - 検索結果、評価集計レスポンスの構造化
- `extension/src/ksupport-content.js`
  - page probe との postMessage ブリッジ
  - 取得した科目・評価集計だけを `chrome.storage.local` に保存
- `extension/src/syllabus-content.js`
  - シラバス情報の抽出
  - background 経由の自動取得
  - ローディング、未ログイン、期限切れ、該当なし、取得成功の表示
- `extension/popup/*`
  - 保存済み件数
  - K-Support 接続状態
  - K-Support を開くボタン

保存するデータ:

- 科目名、教員名、学期、曜日時限、キャンパス、学部
- 回答率
- Q1-Q7 の平均値、選択肢別回答数

保存しないデータ:

- Cookie
- `aura.token`
- `jwt`
- SAML / session 系の値
- 自由記述コメント

実ブラウザで確認した最小 E2E:

```json
{
  "ok": true,
  "match": {
    "score": 100,
    "course": {
      "recordId": "a0AfR000002LwFr",
      "courseName": "計算機システム論",
      "lecturer": "田中 公隆",
      "semester": "2025年秋学期",
      "dayPeriod": "土３",
      "campus": "矢上",
      "faculty": "理工学部"
    }
  },
  "evaluation": {
    "recordId": "a0AfR000002LwFrUAK",
    "answerPercent": 22.22,
    "questionCount": 7,
    "q7Avg": 5,
    "q7Counts": [0, 0, 0, 0, 4]
  }
}
```

この確認では、ログイン済み K-Support ページ内で `fetchEvaluationForSyllabus` コマンドを直接呼び、検索 API と評価詳細 API の両方が成功した。

拡張を Chrome に読み込んだ状態でも、次の実画面 E2E を確認済み。

- 読み込み先: `/Users/masato/Documents/keio-syllabus-survey-overlay/extension`
- 拡張 ID: `fjbifcipikooapjhehafcjjgcdghiolf`
- Human Browser Bridge: connected
- K-Support 検索ページで page probe 自動注入済み
  - `hasAura: true`
  - `hasToken: true`
- 公開シラバス:
  - https://gslbs.keio.jp/pub-syllabus/detail?entno=64690&lang=jp&ttblyr=2025
  - `アルゴリズム同演習 / 青木 義満 / 2025 秋 / 月5 / 日吉 / 理工学部`
- シラバス上の overlay 表示:
  - 照合スコア: `85`
  - K-Support 側で一致した評価: `2024年秋学期`
  - 回答率: `8%`
  - 回答数: `6`
  - Q1-Q7 の平均値、5 段階回答分布、選択肢別割合/人数が表示された
  - 自由記述コメント 3 セクションが表示された
    - 良かった点: 4 件
    - 改善してほしい点: 4 件
    - その他: 1 件
- 表示確認スクリーンショット: `docs/assets/overlay-e2e-algorithm.png`
- 5 段階分布・自由記述込みの表示確認スクリーンショット: `docs/assets/overlay-e2e-algorithm-with-comments.png`

このケースは、2025 年のシラバスから 2024 年の授業評価に照合されている。年度が違う分だけスコアは下がるが、同一科目・同一教員・同一曜日時限として表示対象になる。厳密に同年度だけを表示したい場合は、年度/学期不一致を `NO_MATCH` 扱いにする設定を追加する。

## 検証観点

初期版の手動検証項目:

1. K-Support タブ未表示の状態でシラバスを開く。
   - 期待: `K-Supportを開く` と `再取得` が表示される。
2. K-Support にログイン済みで、授業評価ページまたは検索ページを開いてからシラバスを開く。
   - 期待: 評価カードが自動表示される。
3. 同名科目が複数あるシラバスを開く。
   - 期待: 科目名だけでなく、教員名、学期、曜日時限、キャンパスで最も高いスコアの候補が選ばれる。
4. K-Support タブを長時間放置してから再取得する。
   - 期待: context 期限切れ時は K-Support 再読み込みを促す。
5. 自由記述コメントがある授業評価を開く。
   - 期待: 自由記述は保存・表示されない。

## 旧授業支援の集計結果画面の構造

公開マニュアルのスクリーンショットでは、画面タイトルは「コンテンツ回答結果集計」。

画面上部:

- 授業コンテキスト
  - 例: `【秋学期】 ITC授業サンプル 月1`
  - 教員名らしき表示
- `戻る` ボタン

概要ブロック:

- `カテゴリ`
- `タイトル`
- `説明文`
- `回答完了メッセージ`
- `表示期間`
- `回答期限`
- `匿名性`
- `回答結果公開`

集計ブロック:

- 必須項目の凡例
- `回答者数: 2人` のような回答者数
- 質問テーブル
  - `No`
  - `質問内容`
  - `入力`: 必須/任意
  - `形式`: 単数選択、複数選択、一言入力など
  - 文字数・選択数制限らしき列: `30文字以下`、`3つ以下選択` など

各質問の内側:

- `入力内容` ラベル
- 選択肢名
- 横棒グラフ
- `100.0%(2人)` のような割合と人数
- 自由記述/詳細表示用のボタン
  - 非匿名系の例: `全て表示`
  - 匿名性有効の例: 選択肢ごとの `表示`

## 抽出したいデータモデル

```ts
type SurveyAggregate = {
  source: "keio-legacy-questionnaire" | "keio-ksupport-ksei" | "unknown";
  capturedAt: string;
  course: {
    title?: string;
    term?: string;
    dayPeriod?: string;
    instructor?: string;
    registrationNumber?: string;
    year?: string;
  };
  survey: {
    title?: string;
    category?: string;
    description?: string;
    responseCount?: number;
    isAnonymous?: boolean;
    isPublic?: boolean;
  };
  questions: Array<{
    no: string;
    prompt: string;
    required: boolean | null;
    format: string;
    constraint?: string;
    options: Array<{
      label: string;
      percent: number | null;
      count: number | null;
      hasDetailButton: boolean;
    }>;
    freeTextAvailable: boolean;
  }>;
};
```

## シラバス詳細画面の構造

シラバスは公開ページだけでも DOM が確認できる。

安定して使えそうなセレクタ:

- 画面全体: `#screen-detail`
- 科目名: `.syllabus-header h2.class-name`
- 基本情報表: `.syllabus-header table.table.table-sm`
- 行: `.syllabus-header table tr`
- 見出し: `tr > th`
- 値: `tr > td`
- 詳細セクション: `.syllabus-section`
- セクション名: `.syllabus-section .sub-title`
- セクション本文: `.syllabus-section .contents`

URL パラメータ:

- `ttblyr`: 年度
- `entno`: 登録番号
- `lang`: 言語

シラバス側で取れる主な照合キー:

- 科目名
- 担当者名
- 年度・学期
- 曜日時限
- キャンパス
- 登録番号
- 設置学部・研究科

## 紐付け方針

理想:

1. アンケート結果側に `登録番号` または授業コードがあれば、それを最優先キーにする。
2. なければ、正規化した `年度 + 学期 + 科目名 + 担当者名 + 曜日時限` で照合する。
3. さらに曖昧な場合は `キャンパス` や `設置学部・研究科` を補助キーにする。

正規化ルール候補:

- 全角/半角スペースを統一
- 連続空白を 1 つに圧縮
- `Ａ`/`A` など英数字の全角半角を統一
- 教員名の空白を除去したキーも併用
- `月1` と `月1限` のような表記ゆれを吸収

## Chrome 拡張の読み取り方針

安全で作りやすい順:

1. ユーザーが K-Support の授業評価検索/結果画面を開いたとき、content script が DOM を解析して `chrome.storage.local` に集計結果だけ保存する。
2. ユーザーがシラバス詳細画面を開いたとき、content script が授業キーを作り、保存済み集計を探してシラバス内にカード表示する。
3. 可能なら、K-Support 側の一覧ページから結果ページへのリンク、または検索条件に使われる科目キーも記録する。

保存対象は原則として集計値のみ。自由記述や回答学生一覧は個人情報・センシティブ情報を含む可能性があるため、初期実装では保存しない方がよい。

Salesforce Experience Cloud 前提の注意:

- 初期 HTML にはデータが少なく、ログイン後に Lightning/Aura/LWR の JavaScript が描画する可能性が高い。
- content script は `document_idle` だけでなく、`MutationObserver` で後続描画を待つ必要がある。
- URL が変わらず画面だけ差し替わる SPA 形式の可能性があるため、DOM 監視と `history.pushState`/`popstate` 監視を併用する。
- Shadow DOM が使われている場合は、通常の `querySelector` だけでは足りない。まず実 DOM を確認してから対応方針を決める。

## 未確定点

- `aura.token` / `aura.context` の有効期限と、期限切れ時の再取得フロー。
- 現在の結果画面 DOM に授業登録番号・科目コードが含まれるか。見える範囲では `科目名`、`主担当者`、`学期`、`曜日時限`、`キャンパス`、`学部` が中心。
- 検索 API に登録番号・年度・科目コード相当のフィールドが追加で返るケースがあるか。
- 結果画面が同一ページ内ルーティングの場合、URL 変化と DOM 変化の監視が必要。

## Network API 確定用 DevTools スニペット

ブラウザ自動操作では `javascript:` URL 実行が安全ポリシーでブロックされるため、Network 由来の最小 API 確定は DevTools Console でユーザーが実行するのが安全。

結果ページを開いた状態で DevTools Console に貼る:

```js
copy(JSON.stringify({
  href: location.href,
  title: document.title,
  resources: performance.getEntriesByType("resource")
    .filter((entry) => /aura|sfsites|webruntime|connect|ui-api|graphql|apex|course|evaluation|class|salesforce|keiouniversity/i.test(entry.name))
    .map((entry) => {
      const url = new URL(entry.name, location.href);
      return {
        type: entry.initiatorType,
        path: url.pathname,
        queryKeys: [...url.searchParams.keys()].sort(),
        size: entry.decodedBodySize || entry.transferSize || 0,
      };
    }),
}, null, 2))
```

この出力にはクエリ値や Cookie は含めない。もし `queryKeys` に `jwt` が出ても、値はコピーしない。

## 次に必要な実画面サンプル

本物の結果画面を開ける状態で、以下のどちらかがあると解析を確定できる。

1. ブラウザで「ページのソースを保存」または「HTML のみ保存」したファイル
2. DevTools Console で以下を実行して得た HTML

```js
copy(document.documentElement.outerHTML)
```

個人名・学籍番号・自由記述が入っている場合は、共有前に伏せる。こちらでは、拡張が使うセレクタとパーサをその HTML に合わせて確定する。

より安全な調査用スニペット:

```js
copy(JSON.stringify({
  url: location.href,
  title: document.title,
  bodyText: document.body.innerText.slice(0, 20000),
  headings: [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].map((el) => el.innerText.trim()).filter(Boolean),
  tables: [...document.querySelectorAll('table')].map((table) => table.innerText.slice(0, 5000)),
  buttons: [...document.querySelectorAll('button,a')].map((el) => el.innerText.trim()).filter(Boolean).slice(0, 300),
  customElements: [...new Set([...document.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()).filter((tag) => tag.includes('-')))].sort(),
}, null, 2))
```

これなら完全な HTML より個人情報が混ざりにくく、画面構造の初回把握には十分なことが多い。
