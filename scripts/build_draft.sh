#!/bin/bash
# ドラフト戦略ページのデータ生成（AIで「必要な選手タイプ」）→ git push → Vercel デプロイ。
# 使い方: bash scripts/build_draft.sh
set -uo pipefail
cd "$(dirname "$0")/.." || { echo "repo not found"; exit 1; }
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [ -f .env.local ]; then set -a; source .env.local; set +a; fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "❌ ANTHROPIC_API_KEY が未設定（.env.local を確認）"; exit 1; fi

echo "── ドラフト分析データ生成 ──"
node scripts/build_draft_analysis.mjs || { echo "❌ 生成失敗"; exit 1; }
node -e '
const d=require("./games/draft_analysis_2026.json");
if(!d.strategy||!(d.strategy.needs||[]).length){console.error("⚠️ 必要な選手タイプが空です（API失敗の可能性）");process.exit(1);}
d.strategy.needs.forEach(n=>console.log("  ",n.priority+".",n.type,"／",n.pos,"／",n.profile));
' || { echo "⚠️ 内容を確認してください。デプロイは中止しました"; exit 1; }

bash scripts/deploy_now.sh "feat: ドラフト戦略ページを追加"
