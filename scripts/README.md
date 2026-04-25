# scripts/ — 試合データ自動生成

カープの試合データを NPB公式から取得し、Claude API で「タイトル候補・分岐点・ポジ」を生成して `games/YYYY-MM-DD.json` に書き出します。

## 構成

```
scripts/
  team_codes.mjs     # NPB チームコード ↔ チーム名
  fetch_game.mjs     # NPBスクレイパー（事実データのみ取得）
  generate_ai.mjs    # Claude API で文章生成
  build_game.mjs     # ↑2つを統合してJSON生成・書き出し
```

## ローカル動作確認

```bash
# 依存をインストール
npm install

# 環境変数を設定
export ANTHROPIC_API_KEY=sk-ant-xxx...

# 試運転（ファイル書き込みなし、stdoutに出力）
npm run build:game -- 2026-04-23 --dry

# 実行（games/2026-04-23.json を生成・上書き）
npm run build:game -- 2026-04-23
```

## エラーコード

- `0`: 成功
- `2`: その日に試合がない／未終了（cronから呼ばれた場合は正常扱い）
- `1`: スクレイピング失敗・AI生成失敗・予期しないエラー

## 自動運用

`.github/workflows/update-games.yml` が JST 17:00〜23:00 の30分毎に動き、

1. NPB公式の月次スケジュールから今日の広島の試合URLを検索
2. 試合boxページから事実データ（スコア・イニング・先発・本塁打・打順）を取得
3. その事実データをClaude APIに渡して title_candidates / moments / turning_suggestions / positives を生成
4. `games/YYYY-MM-DD.json` に書き出し
5. 変更があれば自動コミット → Vercelが自動デプロイ

## GitHub Secrets に登録が必要

- `ANTHROPIC_API_KEY`: Claude API キー（既存のVercel環境変数と同じものでOK）

設定方法: GitHub → carp-talk repo → Settings → Secrets and variables → Actions → New repository secret

## 著作権・利用規約への配慮

NPB公式は「掲載の情報、画像、映像等の二次利用および無断転載を固く禁じます」と明記しているため、本スクリプトは：

- **事実データ（スコア・選手名・イニング数）のみ** を取得（著作物にあたらない事実）
- 解説テキスト・記事文を逐語コピーしない
- 文章は AI が事実から再生成
- リクエスト間に1.5秒以上のスリープ（レート制限）
- 自サイトを名乗る User-Agent で識別可能に

それでも、運営者として以下を実施することを推奨：

- NPB から警告が来た場合は即時停止する仕組みを置く
- 利用規約変更を定期的に確認
- 将来的には公式APIや有料データソースへの移行を検討

## 手動上書き

`games/YYYY-MM-DD.json` の `_meta.manuallyEdited: true` を設定すると、自動更新がスキップされます。運営者が編集した内容を保護したい時に。

## トラブルシュート

### 「No Carp game found for ...」が出る
- 月次スケジュールのHTML構造が変更された可能性。`fetch_game.mjs` の `findCarpGameSegment()` を確認
- その日が試合のない日（月曜・休養日など）

### 「Game status is X, not final yet」
- 試合がまだ終了していない。次のcron実行（30分後）まで待つ

### AI生成のJSONがパースできない
- `generate_ai.mjs` の温度（0.4）を下げる、または再試行ロジックを追加
