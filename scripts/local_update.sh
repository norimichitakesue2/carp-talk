#!/bin/bash
# GitHub Actions (update-games.yml) の Mac ローカル代替。
# Actions がアカウントフラグで無効化されている間のつなぎ。
# build_game を今日＋明日ぶん実行し、games/ に変更があれば commit & push する。
#
# 使い方:
#   bash scripts/local_update.sh
# launchd から呼ぶ場合は plist の ProgramArguments でこのスクリプトを指定。

set -uo pipefail

# --- リポジトリのパスを固定（launchd は cwd が / になるため絶対パス必須）---
REPO="/Users/takesue/carp-talk"
cd "$REPO" || { echo "[local_update] repo not found: $REPO"; exit 1; }

# --- ログ ---
LOG="$REPO/.local_update.log"
ts() { TZ='Asia/Tokyo' date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

log "=== local_update start ==="

# --- 環境変数（ANTHROPIC_API_KEY）を .env.local から読む ---
if [ -f "$REPO/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO/.env.local"
  set +a
else
  log "WARN: .env.local not found — AI生成はスキップされる可能性"
fi

# --- node のパス解決（launchd は PATH が最小限）---
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
if [ ! -x "$NODE_BIN" ]; then
  log "ERROR: node not found at $NODE_BIN"
  exit 1
fi
GIT_BIN="$(command -v git || echo /usr/bin/git)"

# --- 最新を取り込む（他所からの push と衝突回避）---
"$GIT_BIN" pull --rebase --autostash origin main >>"$LOG" 2>&1 || log "WARN: git pull --rebase 失敗（続行）"

# --- 対象日（JST）---
TODAY="$(TZ='Asia/Tokyo' date '+%Y-%m-%d')"
TOMORROW="$(TZ='Asia/Tokyo' date -v+1d '+%Y-%m-%d' 2>/dev/null || TZ='Asia/Tokyo' date -d '+1 day' '+%Y-%m-%d')"

# --- build: 今日 ---
log "build today: $TODAY"
OUT="$("$NODE_BIN" scripts/build_game.mjs "$TODAY" 2>&1)"
STATUS=$?
echo "$OUT" >>"$LOG"
log "today build exit: $STATUS"
# status 2 = 試合なし/未確定。0/2 以外は異常だが、明日ぶんは試すので続行する

# --- build: 明日（preview） ---
log "build tomorrow: $TOMORROW"
"$NODE_BIN" scripts/build_game.mjs "$TOMORROW" >>"$LOG" 2>&1
log "tomorrow build exit: $?"

# --- 変更があれば commit & push ---
if [ -z "$("$GIT_BIN" status --porcelain games/)" ]; then
  log "no changes in games/."
else
  log "changes detected, committing..."
  "$GIT_BIN" add games/
  "$GIT_BIN" -c user.name="carp-talk-bot" -c user.email="carp-talk-bot@users.noreply.github.com" \
    commit -m "data: local auto-update $TODAY (+tomorrow)" >>"$LOG" 2>&1
  # push（rebase リトライ付き）
  PUSHED=0
  for i in 1 2 3; do
    if "$GIT_BIN" pull --rebase --autostash origin main >>"$LOG" 2>&1 && "$GIT_BIN" push origin HEAD:main >>"$LOG" 2>&1; then
      PUSHED=1; break
    fi
    log "push attempt $i failed, retry..."
    sleep 5
  done
  if [ "$PUSHED" = "1" ]; then
    log "push OK"
  else
    log "ERROR: push failed after retries"
  fi
fi

log "=== local_update done ==="
