# KOKO を Firebase + Vercel で動かす手順（Windows）

## 0. このフォルダの中身を、今のプロジェクトに重ねる

| このフォルダ | 今の KOKO フォルダ |
|---|---|
| `functions/`（新規） | ルート直下にそのままコピー |
| `firebase.json` `firestore.rules` `vercel.json` | ルート直下にコピー |
| `public/js/api.js` | **上書き**（元の `api.js` は `api.node.js` などの名前で残しておくと戻せます） |
| `public/js/firebase-config.js` | 新規（手順 3 で中身を貼る） |

`app.js` `composer.js` `ink.js` `store.js` などは**変更なし**です。

## 1. Firebase プロジェクトを作る（ブラウザ）

1. https://console.firebase.google.com で「プロジェクトを追加」（名前は `koko` など）
2. 左下「アップグレード」→ **Blaze プラン**にする（Cloud Functions に必要。カード登録が要ります。少人数なら実費はほぼ0円のことが多いです。予算アラートも設定してください）
3. 「構築」→ **Authentication** →「始める」（ログイン方法は何も有効にしなくて OK。カスタムトークンで入ります）
4. 「構築」→ **Firestore Database** →「データベースを作成」→ ロケーション **asia-northeast1（東京）** →「本番環境モード」
5. 歯車 →「プロジェクトの設定」→「マイアプリ」→ **ウェブ（`</>`）** を追加 → 表示される `firebaseConfig` の値を `public/js/firebase-config.js` に貼る

## 2. コマンドでデプロイ（PowerShell、ルートフォルダで）

```powershell
npm install -g firebase-tools
firebase login
firebase use --add            # 作ったプロジェクトを選ぶ
cd functions
npm install
cd ..
firebase deploy --only "functions,firestore:rules"
```

## 3. つまずきやすい所

- **デプロイ後に登録すると「signBlob」「Permission」系のエラー** → Google Cloud コンソール →「IAM」で、Functions が使うサービスアカウント（`<プロジェクト番号>-compute@developer.gserviceaccount.com`）に **「サービス アカウント トークン作成者」** ロールを付ける。カスタムトークンの発行に必要です。
- **古いデータが溜まる** → Firestore →「TTL」で、コレクション グループ `events` `rate` `invites` に、フィールド `expireAt` の TTL ポリシーを作る（イベントは30日で自動削除）。

## 4. 手元で確認（Vercel に上げる前）

今の `npm start` のサーバーは CSP で Firebase への通信を止めるため、画面の確認には使えません。代わりに:

```powershell
npx serve public
```

表示された `http://localhost:3000` を開いて、名前を入れて登録 → 招待リンクを別のブラウザ（シークレットウィンドウ）で開く、で2人分を試せます。

## 5. Vercel に公開

1. Vercel でプロジェクトを作成（GitHub 連携、または `npx vercel`）
2. **Output Directory は `public`**（`vercel.json` に書いてあります）。ビルドコマンドは不要
3. 公開 URL をスマホ2台で開く（HTTPS なので Service Worker・共有ボタンも使えます）

## 今の制限（正直な一覧）

- メッセージの上限を **20,000 点**（約700KB）に下げています（元は 80,000 点）。Firestore の1ドキュメント1MB の制限のためです。ふつうの文章は 数千点なので余裕があります
- 受信は Firestore の読み取りを使います。人数が増えたら料金を確認してください
- 退会時、相手の端末に残る「受信確認」（届きました表示）は元の動きと少し違うことがあります
- レート制限は Firestore のカウンターで実装しています（IP は Functions が見える範囲のもの）。人に広く公開する前に Firebase App Check の導入をおすすめします
- E2EE はありません（変わらず）。筆跡は Google のサーバーに保存されます
- **まだ実際の Firebase では動かしていません。** この環境はネットワークがなく、構文チェックと validate の動作確認だけです。デプロイ時のエラーは貼ってください
