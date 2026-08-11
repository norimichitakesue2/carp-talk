#!/bin/bash
# 手動更新のワンコマンド版。build → git push → Vercel deploy をまとめて実行。
# GitHub Actions がアカウントフラグで無効化されている間の日次更新用。
#
# 使い方:
#   bash scripts/update_now.sh                       # 今日（JST）を更新
#   bash scripts/update_now.sh 2026-08-09            # 指定日を更新
#   bash scripts/update_now.sh 2026-08-08 2026-08-09 # 複数日をまとめて更新
#
# 前提: .env.local に ANTHROPIC_API_KEY があること。Vercel は .vercel でリンク済み。

set -uo pipefail
cd "$(dirname "$0")/.." || { echo "repo not found"; exit 1; }
REPO="$(pwd)"

# --- 環境変数 ---
if [ -f "$REPO/.env.local" ]; then
  set -a; source "$REPO/.env.local"; set +a
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "❌ ANTHROPIC_API_KEY が未設定（.env.local を確認）"; exit 1
fi

# --- 対象日（引数なければ今日 JST）---
if [ "$#" -ge 1 ]; then
  DATES=("$@")
else
  DATES=("$(TZ='Asia/Tokyo' date '+%Y-%m-%d')")
fi

echo "▶ 対象日: ${DATES[*]}"

# --- build ---
CHANGED=0
for d in "${DATES[@]}"; do
  echo "── build $d ──"
  node scripts/build_game.mjs "$d"
  STATUS=$?
  if [ "$STATUS" != "0" ] && [ "$STATUS" != "2" ]; then
    echo "⚠️ $d の build が異常終了 (exit $STATUS)"
  fi
done

# --- 変更がなければ終了 ---
if [ -z "$(git status --porcelain games/)" ]; then
  echo "変更なし。終了。"
  exit 0
fi

# --- commit ---
git add games/
LABEL="$(IFS=,; echo "${DATES[*]}")"
git commit -m "data: ${LABEL} 更新" || { echo "commit失敗"; exit 1; }

# --- push（rebaseリトライ付き）---
PUSHED=0
for i in 1 2 3; do
  if git pull --rebase --autostash origin main && git push origin main; then
    PUSHED=1; break
  fi
  echo "push retry $i..."; sleep 3
done
if [ "$PUSHED" = "1" ]; then echo "✅ push OK"; else echo "❌ push失敗"; fi

# --- Vercel 本番デプロイ ---
echo "── vercel deploy ──"
if npx vercel --prod --yes; then
  echo "✅ deploy OK"
else
  echo "⚠️ deploy 失敗（gitには反映済み）"
fi

echo "🏁 done: ${DATES[*]}"
