#!/bin/bash
# サイトの変更（コード/データ）をまとめて git push → Vercel 本番デプロイ。
# ゲームのAIビルドは行わない純粋なデプロイ用。ANTHROPIC_API_KEY 不要。
#
# 使い方:
#   bash scripts/deploy_now.sh                 # 変更ファイルすべてをコミットしてデプロイ
#   bash scripts/deploy_now.sh "コミットメッセージ"
#
# 前提: Vercel は .vercel でリンク済み。git remote (origin/main) にpush可能なこと。

set -uo pipefail
cd "$(dirname "$0")/.." || { echo "repo not found"; exit 1; }

MSG="${1:-chore: サイト更新}"

# node パスのフォールバック（launchd/非対話shell対策）
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# --- 変更がなければ終了 ---
if [ -z "$(git status --porcelain)" ]; then
  echo "変更なし。デプロイのみ実行します。"
else
  git add -A
  git commit -m "$MSG" || { echo "commit失敗"; exit 1; }
fi

# --- push（rebaseリトライ付き）---
PUSHED=0
for i in 1 2 3; do
  if git pull --rebase --autostash origin main && git push origin main; then
    PUSHED=1; break
  fi
  echo "push retry $i..."; sleep 3
done
if [ "$PUSHED" = "1" ]; then echo "✅ push OK"; else echo "⚠️ push失敗（Vercelデプロイは継続）"; fi

# --- Vercel 本番デプロイ ---
echo "── vercel deploy ──"
if npx vercel --prod --yes; then
  echo "✅ deploy OK"
else
  echo "❌ deploy 失敗"; exit 1
fi

echo "🏁 done"
