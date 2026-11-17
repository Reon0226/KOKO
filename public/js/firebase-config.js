// Firebase コンソール →（プロジェクトの設定）→ マイアプリ（Web）の firebaseConfig を貼る。
// これは公開されても問題ない設定値です（秘密鍵ではありません）。守っているのは firestore.rules と Functions です。
export const firebaseConfig = {
  apiKey: 'AIzaSyBS1xgwjy-c-exoaxTMTthQjDlMrU1B7cE',
  authDomain: 'koko-32dd4.firebaseapp.com',
  projectId: 'koko-32dd4',
  appId: '1:1032517837563:web:3a23a3f189ec6db19a065e',
};
export const REGION = 'asia-northeast1'; // 東京。functions/index.js の region と合わせる