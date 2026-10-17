#!/bin/bash
# シーズン総括を再生成（AIで総括文・選手個人の振り返り）→ git push → Vercel デプロイ。
# 成績は games/npb_official_2026.json（NPB公式確定値）を使用。
#
# 使い方: bash scripts/build_season.sh
# 前提: .env.local に ANTHROPIC_API_KEY

set -uo pipefail
cd "$(dirname "$0")/.." || { echo "repo not found"; exit 1; }
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if [ -f .env.local ]; then set -a; source .env.local; set +a; fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "❌ ANTHROPIC_API_KEY が未設定（.env.local を確認）"; exit 1; fi

echo "── 総括データ生成 ──"
node scripts/build_season_summary.mjs || { echo "❌ 生成失敗"; exit 1; }

# 生成結果の簡易チェック
node -e '
const s=require("./games/season_summary_2026.json");
console.log("成績:",s.record.w+"勝"+s.record.l+"敗"+s.record.d+"分","/ 順位:",s.league&&s.league.standing+"位");
console.log("総括タイトル:",s.narrative&&s.narrative.title);
console.log("選手振り返り:",(s.players||[]).length+"人 / 救った・痛かった場面つき:",(s.players||[]).filter(p=>p.scenes).length+"人");
(s.players||[]).filter(p=>p.scenes).sort((a,b)=>b.scenes.saved-a.scenes.saved).slice(0,5).forEach(p=>console.log("  ",p.name,"救"+p.scenes.saved,"痛"+p.scenes.hurt));
if(!(s.players||[]).length){console.error("⚠️ 選手振り返りが空です（API失敗の可能性）");process.exit(1);}
' || { echo "⚠️ 内容を確認してください。デプロイは中止しました"; exit 1; }

bash scripts/deploy_now.sh "feat: シーズン総括にチーム指標・リーグ順位・選手個人の振り返りを追加"
