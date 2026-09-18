#!/bin/bash
# 死んだ refresh-carp-batters.yml (GitHub Actions) の Mac ローカル代替。
# カープ打者成績・ファーム成績・1軍公示ロースターを更新して commit/push/deploy する。
# これらは NPBスクレイプのみで Anthropic API 不要（クレジット切れでも動く）。
#
# 使い方: bash scripts/local_refresh.sh

set -uo pipefail
cd "$(dirname "$0")/.." || { echo "repo not found"; exit 1; }

echo "▶ カープ各種データを更新中..."

echo "── ① 打者成績 (nf3) ──"
node scripts/refresh_carp_batters.mjs || echo "⚠️ batter refresh 失敗"
echo "── ② ファーム成績 (NPB) ──"
node scripts/fetch_npb_farm.mjs || echo "⚠️ farm refresh 失敗"
echo "── ③ 1軍公示ロースター (NPB公示) ──"
node scripts/fetch_npb_official_roster.mjs || echo "⚠️ roster refresh 失敗"

FILES="games/nf3_carp_batters.json games/npb_farm_carp.json games/npb_official_roster_c.json"
if [ -z "$(git status --porcelain $FILES)" ]; then
  echo "変更なし。終了。"
  exit 0
fi

git add $FILES
git commit -m "data: refresh carp batter + farm + roster (local)" || { echo "commit失敗"; exit 1; }

PUSHED=0
for i in 1 2 3; do
  if git pull --rebase --autostash origin main && git push origin main; then PUSHED=1; break; fi
  echo "push retry $i..."; sleep 3
done
[ "$PUSHED" = "1" ] && echo "✅ push OK" || echo "❌ push失敗"

echo "── Vercel deploy ──"
npx vercel --prod --yes && echo "✅ deploy OK" || echo "⚠️ deploy失敗（gitには反映済み）"
echo "🏁 refresh done"
