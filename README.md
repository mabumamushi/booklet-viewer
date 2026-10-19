# 冊子Checker

閲覧順のPDFを、表紙・見開き・裏表紙として確認するブラウザーアプリです。PDFは利用者が選択し、ブラウザー内で処理します。PDFをサーバーへ送信するコードはありません。

## できること

- 1ページ目を表紙、2–3ページから見開き、最終ページを裏表紙として表示
- 左右の矢印、左右キー、横スワイプで見開きを1つずつめくるアニメーション
- 下部バーで表示先を確認し、アニメーションなしで直接移動
- 60〜250%の滑らかなズームと全体表示
- PDF内の文字検索と該当見開きへの移動
- PDFのドラッグ＆ドロップ、スマートフォン表示

画像だけのPDFには文字検索を使えません。事前にOCR処理されたPDFなら検索できます。中面が奇数ページの場合、裏表紙の前の見開きに空白を表示します。この空白は元のPDFを変更しません。拡大中の横方向の操作はPDFの移動に使い、100%以下では横スワイプでページをめくれます。

## ローカルで開く

Node.js 20以上とPython 3を使用します。初回に依存パッケージを取得し、PDF.jsの表示用ファイルを `vendor/` に生成します。その後、ローカルHTTPサーバーを起動します。

```bash
npm install
python3 -m http.server 8000
```

ブラウザーで `http://localhost:8000` を開いてください。`file://` で直接開くと、PDF.jsのワーカーが動かない場合があります。

## GitHub Pagesで公開する

公開サイト: https://mabumamushi.github.io/booklet-viewer/

`main` ブランチへの変更を GitHub Actions が検証・ビルドし、`dist/` を GitHub Pages に公開します。GitHub の **Settings → Pages → Build and deployment** で **GitHub Actions** を公開元として選びます。GitHub Free を利用する場合は、リポジトリを **Public** にします。

公開URLを共有すれば、相手はスマートフォンやPCからサイトを開けます。利用者は各自の端末でPDFを選択します。PDFファイルはリポジトリに追加せず、選択したPDFはGitHub Pages側にも保存されません。

## 構成

- `index.html`、`styles.css` — UI
- `main.js` — PDF読み込み、描画、移動、検索
- `page-model.js` — PDFページ番号から見開きへの対応
- `prepare-assets.mjs`、`build.mjs` — PDF.jsの資産準備と静的サイトの生成
- `assets/Makinas-4-Flat.otf` — 画面表示に使うフォント
- `vendor/` — PDF.js 5.6.205（Apache License 2.0）とその同梱資産。`npm install` で生成され、Git管理には含まれません

ページの並び替えは、今後 `pageOrder` の順番を編集するUIを加える設計です。`page-model.js` はその順番から見開きを組み立てます。

## 確認

Node.jsがある場合は `npm test` でページの組み合わせを検証できます。
