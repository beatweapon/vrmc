# vrmc

VRM.ver1.0 で配信する用のアプリケーション。
https://beatweapon.github.io/vrmc/

- ドラッグアンドドロップで任意の VRM ファイルをロードできます。
- Ctrl+左右キーで背景色を変更できます。
- 今のところカメラ選択の UI はありません。需要があれば実装するかも。

依存ライブラリ（2026-09-07 更新）:

| ライブラリ | バージョン |
| --- | --- |
| Three.js | 0.185.1 |
| @pixiv/three-vrm | 3.5.5 |
| @mediapipe/tasks-vision | 1.0.1 |
| ws（サーバー） | 8.21.3 |

フロントエンドは `docs/index.html` と `docs/party/index.html` の import map から CDN の固定バージョンを読み込みます。更新時は両画面を揃え、MediaPipe の JavaScript と WASM も同じバージョンにしてください。HTML の更新に合わせて `docs/service-worker.js` の `CACHE_NAME` も更新します。

WebSocket サーバーは `server` ディレクトリで `npm ci`、`npm start` を実行して起動します（ポート 3000）。Node.js 24.18.0 で動作確認しています。パーティ画面の接続先は `docs/party/wsClient.js` の `SERVER_URL` で指定します。
