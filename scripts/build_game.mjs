// fetch_game.mjs と generate_ai.mjs を統合して、games/YYYY-MM-DD.json を生成
//
// 使い方:
//   node scripts/build_game.mjs YYYY-MM-DD [--dry] [--no-ai]
//   --dry    生成するJSONを stdout に出すだけ、ファイルへ書き込まない
//   --no-ai  Claude APIを呼ばずに事実データのみで構築（軽くテスト用）
//
// 終了コード:
//   0 : 成功
//   2 : その日に試合がない、または未終了
//   1 : エラー

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(REPO_ROOT, 'games');

function runNode(script, args, stdinInput) {
  const r = spawnSync(process.execPath, [script, ...args], {
    input: stdinInput,
    encoding: 'utf8',
    env: process.env,
    cwd: REPO_ROOT,
    maxBuffer: 1024 * 1024 * 10,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const hasArg = (name) => process.argv.includes(`--${name}`);
const pickDateArg = () => {
  const a = process.argv.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
  return a || new Date().toISOString().slice(0, 10);
};

// 指定日より前の直近の試合JSONから players（最新の1軍公示）を探す。
// carpRoster が空の試合（Yahoo由来の未来の試合など）のフォールバック用。
async function findLatestRoster(beforeDate) {
  let files;
  try {
    files = await fs.readdir(GAMES_DIR);
  } catch { return null; }
  const gameDates = files
    .filter((fn) => /^\d{4}-\d{2}-\d{2}\.json$/.test(fn))
    .map((fn) => fn.replace('.json', ''))
    .filter((d) => d < beforeDate)   // 指定日より前
    .sort()
    .reverse();                       // 新しい順
  for (const d of gameDates) {
    try {
      const g = JSON.parse(await fs.readFile(path.join(GAMES_DIR, `${d}.json`), 'utf8'));
      if (Array.isArray(g.players) && g.players.length > 0) {
        return { date: d, players: g.players.map((p) => ({ name: p.name, pos: p.pos || '?' })) };
      }
    } catch { /* skip */ }
  }
  return null;
}

// 指定日より前の games を新しい順に読む（共通ヘルパー）
async function listPastGames(beforeDate) {
  let files;
  try { files = await fs.readdir(GAMES_DIR); } catch { return []; }
  return files
    .filter((fn) => /^\d{4}-\d{2}-\d{2}\.json$/.test(fn))
    .map((fn) => fn.replace('.json', ''))
    .filter((d) => d < beforeDate)
    .sort()
    .reverse();
}

// 相手先発投手との「今季の全カープ対戦」を games archive から集計する。
// 相手先発（広島側でない away/home_pitcher）が今日の相手先発と一致する
// 同年の final 試合をすべて集め、チーム成績・打者別成績を合算して返す。
async function findSeasonMatchups(opponentStarter, beforeDate) {
  if (!opponentStarter) return null;
  const target = opponentStarter.replace(/\s+/g, '');
  const year = beforeDate.slice(0, 4);
  const games = [];
  for (const d of await listPastGames(beforeDate)) {
    if (!d.startsWith(year)) continue;   // 同年のみ
    let g;
    try { g = JSON.parse(await fs.readFile(path.join(GAMES_DIR, `${d}.json`), 'utf8')); }
    catch { continue; }
    if (g.status !== 'final') continue;
    const carpIsHome = g.home_team === '広島';
    const opStarter = (carpIsHome ? g.away_pitcher : g.home_pitcher) || '';
    if (opStarter.replace(/\s+/g, '') !== target) continue;
    const carpScore = carpIsHome ? g.home_score : g.away_score;
    const opScore   = carpIsHome ? g.away_score : g.home_score;
    games.push({
      date: g.game_date,
      opponent: carpIsHome ? g.away_team : g.home_team,
      venue: g.venue || '',
      carpScore, opScore,
      result: g.result_label || '',
      carpWon: (carpScore != null && opScore != null) ? carpScore > opScore : null,
      carpBatting: (g.carp_batting || []).map((b) => ({
        name: b.name, line: b.line ?? null,
        ab: b.ab ?? 0, h: b.h ?? 0, hr: b.hr ?? 0, rbi: b.rbi ?? 0,
        k: b.k ?? 0, bb: b.bb ?? 0,
        double: b.double ?? 0, triple: b.triple ?? 0,
      })),
    });
  }
  if (games.length === 0) return null;

  // games は新しい順。チーム合算 & 打者別合算
  const teamTotals = { games: games.length, ab: 0, h: 0, hr: 0, k: 0, bb: 0,
    double: 0, triple: 0, rbi: 0, carpWins: 0 };
  const perBatter = {};   // name -> 合算
  for (const gm of games) {
    if (gm.carpWon === true) teamTotals.carpWins += 1;
    for (const b of gm.carpBatting) {
      teamTotals.ab += b.ab; teamTotals.h += b.h; teamTotals.hr += b.hr;
      teamTotals.k += b.k; teamTotals.bb += b.bb;
      teamTotals.double += b.double; teamTotals.triple += b.triple;
      teamTotals.rbi += b.rbi;
      if (!b.name) continue;
      if (!perBatter[b.name]) {
        perBatter[b.name] = { name: b.name, ab: 0, h: 0, hr: 0, rbi: 0, k: 0, bb: 0, double: 0, triple: 0 };
      }
      const pb = perBatter[b.name];
      pb.ab += b.ab; pb.h += b.h; pb.hr += b.hr; pb.rbi += b.rbi;
      pb.k += b.k; pb.bb += b.bb; pb.double += b.double; pb.triple += b.triple;
    }
  }
  const fmt3 = (n) => n.toFixed(3).replace(/^0/, '');
  teamTotals.avg = teamTotals.ab ? fmt3(teamTotals.h / teamTotals.ab) : '.000';

  const batters = Object.values(perBatter)
    .filter((b) => b.ab >= 1)
    .map((b) => ({ ...b, avg: b.ab ? fmt3(b.h / b.ab) : '.000' }))
    .sort((a, b) => b.ab - a.ab);

  return {
    count: games.length,
    games,                    // 個別試合（新しい順）
    teamTotals,
    batters,                  // 打者別合算（打数順）
    lastDate: games[0].date,  // 最新対戦日
  };
}

// 直近 n 試合のカープ打順（1〜9番）を抽出する。
// carp_batting の line でソートして [{line, name, pos}] にする。
async function getRecentLineups(beforeDate, n = 3) {
  const out = [];
  for (const d of await listPastGames(beforeDate)) {
    if (out.length >= n) break;
    let g;
    try { g = JSON.parse(await fs.readFile(path.join(GAMES_DIR, `${d}.json`), 'utf8')); }
    catch { continue; }
    if (g.status !== 'final') continue;
    const batting = (g.carp_batting || []).filter((b) => b.line != null);
    if (batting.length === 0) continue;
    // line でソートし、各打順の先発（最初に出てきた選手）を採用
    const byLine = {};
    for (const b of batting) {
      if (b.line >= 1 && b.line <= 9 && !byLine[b.line]) {
        byLine[b.line] = { line: b.line, name: b.name, pos: b.pos || '' };
      }
    }
    const order = Object.values(byLine).sort((a, b) => a.line - b.line);
    if (order.length >= 5) out.push({ date: g.game_date, order });
  }
  return out;
}

function assembleGameJson(date, factsRoot, generated, prev) {
  const f = factsRoot.facts;
  const ls = f.lineScore || {};
  const carpIsHome = !!f.carpIsHome;
  const status = f.status || 'final';
  const isFinal = status === 'final';
  const isLive = status === 'live';
  const isCancelled = status === 'cancelled';
  const writeScores = isFinal || isLive;  // live 中もスコアとイニングを書き出す

  const homeTeam = ls.home?.team || (carpIsHome ? '広島' : '');
  const awayTeam = ls.away?.team || (carpIsHome ? '' : '広島');
  const homeScore = ls.home?.total ?? null;
  const awayScore = ls.away?.total ?? null;

  // innings オブジェクト形式に変換（試合終了時 + 試合中）
  const inningsObj = {};
  if (writeScores) {
    if (carpIsHome && ls.home) {
      inningsObj.hiroshima = ls.home.innings;
      inningsObj.hiroshima_hits = ls.home.hits;
      inningsObj.hiroshima_errors = ls.home.errors;
    } else if (!carpIsHome && ls.away) {
      inningsObj.hiroshima = ls.away.innings;
      inningsObj.hiroshima_hits = ls.away.hits;
      inningsObj.hiroshima_errors = ls.away.errors;
    }
    const opSide = carpIsHome ? ls.away : ls.home;
    if (opSide) {
      inningsObj.away = opSide.innings;
      inningsObj.away_hits = opSide.hits;
      inningsObj.away_errors = opSide.errors;
    }
  }

  // 投手リスト
  // 注意: 「先発」「勝利投手」「敗戦投手」「セーブ投手」は別物。
  // サヨナラ試合では 勝利/敗戦投手は中継ぎ・抑えになることもあるので、
  // 先発を別エントリで持ち、勝/敗/Sは結果として記録する。
  const pitchers = [];
  const pp = f.pitchers || {};
  if (isFinal) {
    const winnerTeam = (homeScore > awayScore) ? homeTeam : awayTeam;
    const loserTeam  = (homeScore > awayScore) ? awayTeam : homeTeam;
    const carpTeam = carpIsHome ? homeTeam : awayTeam;
    const opTeam   = carpIsHome ? awayTeam : homeTeam;

    // 1. 先発投手 (本物の先発)
    if (pp.carpStarter) pitchers.push({ team: carpTeam, role: '先発', name: pp.carpStarter, result: '' });
    if (pp.opStarter)   pitchers.push({ team: opTeam,   role: '先発', name: pp.opStarter,   result: '' });

    // 2. 勝/敗/S は別エントリ。先発がそのまま勝敗投手なら role を「先発 勝」のように合成
    const composeRole = (name, base) => {
      if (name && (name === pp.carpStarter || name === pp.opStarter)) {
        // 先発エントリの result を上書きしてマージ
        const ent = pitchers.find(p => p.name === name && p.role === '先発');
        if (ent) ent.result = base;
        return null; // 別エントリは追加しない
      }
      return base;
    };
    if (pp.winningPitcher) {
      const r = composeRole(pp.winningPitcher, 'win');
      if (r) pitchers.push({ team: winnerTeam, role: '勝', name: pp.winningPitcher, result: 'win' });
    }
    if (pp.losingPitcher) {
      const r = composeRole(pp.losingPitcher, 'loss');
      if (r) pitchers.push({ team: loserTeam, role: '敗', name: pp.losingPitcher, result: 'loss' });
    }
    if (pp.savePitcher) {
      const r = composeRole(pp.savePitcher, 'save');
      if (r) pitchers.push({ team: winnerTeam, role: 'S', name: pp.savePitcher, result: 'save' });
    }
  }

  // 試合前 / 試合中の場合は previous JSON から AI生成フィールドを保持（マージ）
  // ID は必ず date-prefix にして、複数日のデータがSupabaseで衝突しないようにする
  const useGeneratedAi = isFinal && (generated.title_candidates?.length || generated.moments?.length);
  const datePrefix = date.replaceAll('-', '');
  const moments = useGeneratedAi
    ? (generated.moments || []).map((m, i) => ({ id: i + 1, ...m }))
    : (prev?.moments || []);
  const positives = useGeneratedAi
    ? (generated.positives || []).map((p, i) => ({ ...p, id: `p_${datePrefix}_${i + 1}` }))
    : (prev?.positives || []);
  const titleCandidates = useGeneratedAi
    ? (generated.title_candidates || [])
    : (prev?.title_candidates || []);
  const turningSuggestions = useGeneratedAi
    ? (generated.turning_suggestions || [])
    : (prev?.turning_suggestions || []);
  const debates = useGeneratedAi
    ? (generated.debates || []).map((d, i) => ({ ...d, id: `d_${datePrefix}_${i + 1}` }))
    : (prev?.debates || []);
  const teamAnalysis = useGeneratedAi
    ? (generated.team_analysis || null)
    : (prev?.team_analysis || null);
  // preview は試合前 (scheduled/live) のAI生成で出てくる。final 時は prev を維持（試合中の予想は残す）
  const preview = generated?.preview
    ? generated.preview
    : (prev?.preview || null);

  let resultLabel = '';
  if (isFinal && homeScore != null && awayScore != null) {
    if (homeScore !== awayScore) {
      const winner = homeScore > awayScore ? homeTeam : awayTeam;
      resultLabel = `${winner}勝利`;
    } else {
      resultLabel = '引き分け';
    }
  } else if (isCancelled) {
    resultLabel = '試合中止';
  }

  const carpStarter = pp.carpStarter || '';
  const opStarter = pp.opStarter || '';
  const homePitcher = carpIsHome ? carpStarter : opStarter;
  const awayPitcher = carpIsHome ? opStarter : carpStarter;

  return {
    id: `npb_${date.replaceAll('-', '')}`,
    game_date: date,
    away_team: awayTeam,
    home_team: homeTeam,
    away_score: writeScores ? (awayScore ?? 0) : null,
    home_score: writeScores ? (homeScore ?? 0) : null,
    venue: f.venue || (carpIsHome ? 'マツダスタジアム' : ''),
    start_time: f.startTime || '',
    status,
    current_inning: f.currentInning || '',
    result_label: resultLabel,
    away_pitcher: awayPitcher || prev?.away_pitcher || '',
    home_pitcher: homePitcher || prev?.home_pitcher || '',
    title_candidates: titleCandidates,
    positives,
    turning_suggestions: turningSuggestions,
    debates,
    team_analysis: teamAnalysis,
    preview,
    innings: inningsObj,
    pitchers,
    moments,
    // players はスタメン予想機能で使うので、常に carpRoster（ベンチ入り26人）を最優先
    // carpRoster が無い場合だけ carpLineup（実際の出場選手）→ prev → CARP_PLAYERS_MASTER の順でフォールバック
    players: (f.carpRoster && f.carpRoster.length > 0)
      ? f.carpRoster.map((p) => ({ name: p.name, pos: p.pos || '?' }))
      : (isFinal
          ? (f.carpLineup || []).map((p) => ({ name: p.name, pos: p.pos || '?' }))
          : (prev?.players || [])),
    // carp_batting: その試合のカープ各打者の打撃成績（直近成績の集計用）
    // final/live のみ。試合前は prev を維持（無ければ空配列）
    carp_batting: (isFinal || isLive)
      ? (f.carpLineup || [])
          .filter((p) => p.ab != null && p.ab >= 0)
          .map((p) => ({
            name: p.name, pos: p.pos || '', line: p.line ?? null,
            ab: p.ab ?? 0, r: p.r ?? 0, h: p.h ?? 0,
            rbi: p.rbi ?? 0, sb: p.sb ?? 0, hr: p.hr ?? 0,
            k: p.k ?? 0, bb: p.bb ?? 0,
            double: p.double ?? 0, triple: p.triple ?? 0,
            single: p.single ?? 0, hbp: p.hbp ?? 0, sf: p.sf ?? 0,
          }))
      : (prev?.carp_batting || []),
    // carp_pitching: その試合のカープ各投手の投球成績（直近成績の集計用）
    carp_pitching: (isFinal || isLive)
      ? (pp.carpAll || [])
          .filter((p) => p.name)
          .map((p) => ({
            name: p.name, result: p.result || '', outs: p.outs ?? 0,
            pitches: p.pitches ?? 0, hitsAllowed: p.hitsAllowed ?? 0,
            hrAllowed: p.hrAllowed ?? 0, walks: p.walks ?? 0,
            strikeouts: p.strikeouts ?? 0, runs: p.runs ?? 0, earnedRuns: p.earnedRuns ?? 0,
          }))
      : (prev?.carp_pitching || []),
    _meta: {
      sourceFetchedAt: factsRoot.fetchedAt,
      generatedAt: new Date().toISOString(),
      // Yahoo 由来（未来の試合プレビュー）は NPB の scores URL が存在しないため出さない
      sourceUrl: (factsRoot.source === 'yahoo.co.jp' || String(factsRoot.segment).startsWith('yahoo-'))
        ? `https://baseball.yahoo.co.jp/npb/schedule/?selectDate=${date}`
        : `https://npb.jp/scores/${date.slice(0,4)}/${date.slice(5,7)}${date.slice(8,10)}/${factsRoot.segment}/`,
    },
  };
}

async function main() {
  const date = pickDateArg();
  const dry = hasArg('dry');
  const noAi = hasArg('no-ai');
  console.error(`[build_game] Building game data for ${date} (dry=${dry}, no-ai=${noAi})`);

  // 緊急停止スイッチ
  const killSwitch = path.join(REPO_ROOT, '.disable-auto-update');
  try {
    await fs.access(killSwitch);
    console.error('[build_game] .disable-auto-update file found; aborting.');
    process.exit(0);
  } catch { /* not present */ }

  // STEP1: スクレイピング
  const fetchScript = path.join(__dirname, 'fetch_game.mjs');
  const fetchResult = runNode(fetchScript, [date]);
  if (fetchResult.status === 2) {
    console.error(`[build_game] No game today. ${fetchResult.stderr.trim()}`);
    process.exit(2);
  }
  if (fetchResult.status !== 0) {
    console.error(`[build_game] fetch_game failed:\n${fetchResult.stderr}`);
    process.exit(1);
  }
  let facts;
  try {
    facts = JSON.parse(fetchResult.stdout);
  } catch (e) {
    console.error(`[build_game] failed to parse fetch_game output: ${e.message}`);
    console.error(fetchResult.stdout.slice(0, 500));
    process.exit(1);
  }

  const status = facts?.facts?.status;
  if (status === 'unknown') {
    console.error(`[build_game] Game status is "unknown", skipping.`);
    process.exit(2);
  }
  // status === 'cancelled' は skip せず、JSONを書き出して中止表示できるようにする
  if (status === 'cancelled') {
    console.error(`[build_game] Game status is "cancelled", writing JSON to mark as 試合中止.`);
  }

  // STEP2: 既存JSONを先に読む（キャッシュ判定用）
  const outPath = path.join(GAMES_DIR, `${date}.json`);
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(outPath, 'utf8')); } catch { /* not existing */ }
  if (prev?._meta?.manuallyEdited) {
    console.error(`[build_game] ${outPath} is manually edited; skipping overwrite.`);
    process.exit(0);
  }

  // STEP2.5: carpRoster が空なら直近試合の players（最新の1軍公示）で補完する。
  // Yahoo 由来の未来の試合や、NPB がまだ公示を出していない試合では
  // carpRoster が空になり、AI preview のフィルタが効かず抹消選手が混ざるため。
  if (!facts.facts) facts.facts = {};
  if (!Array.isArray(facts.facts.carpRoster) || facts.facts.carpRoster.length === 0) {
    const latestRoster = await findLatestRoster(date);
    if (latestRoster && latestRoster.players.length > 0) {
      facts.facts.carpRoster = latestRoster.players;
      console.error(`[build_game] carpRoster empty → backfilled from ${latestRoster.date} (${latestRoster.players.length} players)`);
    }
  }

  // STEP3: AI生成
  // - final: 全部生成（タイトル候補・分岐点・ポジ・debates・team_analysis）
  // - scheduled/live: 先発判明＆既存previewなし → preview生成、それ以外はスキップ
  let generated = { title_candidates: [], moments: [], turning_suggestions: [], positives: [], debates: [] };
  const f = facts?.facts || {};
  const hasStarter = !!(f.pitchers?.carpStarter && f.pitchers?.opStarter);
  const hasExistingPreview = !!(prev?.preview && (prev.preview.watchpoints?.length || prev.preview.key_players?.length));
  let shouldRunAi = false;
  if (!noAi) {
    if (status === 'final') {
      shouldRunAi = true;
    } else if ((status === 'scheduled' || status === 'live') && hasStarter && !hasExistingPreview) {
      shouldRunAi = true;
    }
    // cancelled の場合は AI を走らせない（試合自体が無いので分析対象なし）
  }

  // STEP3.4: カープ打者の通算 + 対右/対左 成績キャッシュを読み込む（Phase 4）
  // 1日1回 refresh-carp-batters ワークフローで生成される games/nf3_carp_batters.json
  if (shouldRunAi && (status === 'scheduled' || status === 'live')) {
    try {
      const cachePath = path.join(GAMES_DIR, 'nf3_carp_batters.json');
      const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if (cache?.batters?.length) {
        if (!facts.facts) facts.facts = {};
        facts.facts.carpBatters = cache.batters;
        console.error(`[build_game] Loaded carp batter cache: ${cache.batters.length} batters (${cache.fetchedAt})`);
      }
    } catch (e) {
      console.error(`[build_game] No carp batter cache available (${e.code || e.message})`);
    }
  }

  // STEP3.45: Phase 8 — 前回対戦の振り返り・直近打順・選手の調子を facts に注入
  if (shouldRunAi && (status === 'scheduled' || status === 'live')) {
    // (a) 相手先発との今季の全カープ対戦
    const opStarterName = f.pitchers?.opStarter || '';
    if (opStarterName) {
      try {
        const seasonMatchups = await findSeasonMatchups(opStarterName, date);
        if (seasonMatchups) {
          facts.facts.seasonMatchups = seasonMatchups;
          console.error(`[build_game] season matchups vs ${opStarterName}: ${seasonMatchups.count}試合 通算${seasonMatchups.teamTotals.avg}`);
        } else {
          console.error(`[build_game] no past matchup vs ${opStarterName} in archive`);
        }
      } catch (e) {
        console.error(`[build_game] findSeasonMatchups error: ${e.message}`);
      }
    }
    // (b) 直近3試合の打順
    try {
      const recentLineups = await getRecentLineups(date, 3);
      if (recentLineups.length) {
        facts.facts.recentLineups = recentLineups;
        console.error(`[build_game] recent lineups: ${recentLineups.map(l => l.date).join(', ')}`);
      }
    } catch (e) {
      console.error(`[build_game] getRecentLineups error: ${e.message}`);
    }
    // (c) 選手の調子（既存の recent_form.json を読む。STEP6 で更新される前の=昨日までの状態）
    try {
      const rf = JSON.parse(await fs.readFile(path.join(GAMES_DIR, 'recent_form.json'), 'utf8'));
      if (rf?.players?.length) {
        facts.facts.recentForm = rf;
        console.error(`[build_game] recent_form loaded: ${rf.players.length} batters (${rf.rangeStart}〜${rf.rangeEnd})`);
      }
    } catch { /* recent_form がまだ無い場合はスキップ */ }
    // (d) カープ2軍（ファーム）成績 — コールアップ提案用
    try {
      const farm = JSON.parse(await fs.readFile(path.join(GAMES_DIR, 'npb_farm_carp.json'), 'utf8'));
      if (farm && (farm.batters?.length || farm.pitchers?.length)) {
        facts.facts.farmStats = farm;
        console.error(`[build_game] farm stats loaded: 打者${farm.batters?.length || 0}人 / 投手${farm.pitchers?.length || 0}人`);
      }
    } catch { /* npb_farm_carp.json がまだ無い場合はスキップ */ }
  }

  // STEP3.5: nf3 から相手先発の詳細統計を取得（preview生成時のみ・取得失敗しても継続）
  // Phase 2: 相手投手の通算/今季成績 (防御率/WHIP/QS率/被本塁打/直近登板など)
  if (shouldRunAi && (status === 'scheduled' || status === 'live') && hasStarter) {
    const opTeamName = f.carpIsHome
      ? (f.lineScore?.away?.team || '')
      : (f.lineScore?.home?.team || '');
    const opStarterName = f.pitchers?.opStarter || '';
    if (opTeamName && opStarterName) {
      console.error(`[build_game] Fetching nf3 stats for ${opTeamName} ${opStarterName}...`);
      try {
        const { fetchOpponentPitcherData } = await import('./fetch_nf3.mjs');
        // Phase 3: vs カープ打者の通算成績も取得 (fetch +1)
        const nf3 = await fetchOpponentPitcherData(opTeamName, opStarterName, { includeVsBatters: true });
        if (nf3) {
          if (!facts.facts) facts.facts = {};
          facts.facts.opponentPitcherNf3 = nf3;
          const vsCarpCount = Array.isArray(nf3.vsCarp) ? nf3.vsCarp.length : 0;
          console.error(`[build_game] nf3 stats: 防御率${nf3.stats?.era ?? '?'} / WHIP${nf3.stats?.whip ?? '?'} / QS率${nf3.stats?.qsRate ?? '?'} / vs カープ打者${vsCarpCount}人`);
        } else {
          console.error('[build_game] nf3 returned null (skipping enrichment)');
        }
      } catch (e) {
        console.error(`[build_game] nf3 fetch error (skipping): ${e.message}`);
      }
    }
  }

  if (shouldRunAi) {
    const aiScript = path.join(__dirname, 'generate_ai.mjs');
    const aiResult = runNode(aiScript, [], JSON.stringify(facts));
    if (aiResult.status !== 0) {
      console.error(`[build_game] generate_ai failed:\n${aiResult.stderr}`);
      process.exit(1);
    }
    try {
      generated = JSON.parse(aiResult.stdout);
    } catch (e) {
      console.error(`[build_game] failed to parse AI output: ${e.message}`);
      console.error(aiResult.stdout.slice(0, 500));
      process.exit(1);
    }

    // 守備位置被り検証: AI が守備整合に失敗してたら lineup_proposal を無効化
    // （嘘の提案を出すよりは「提案なし」の方が誠実）
    const lp = generated?.preview?.lineup_proposal;
    if (lp && Array.isArray(lp.order) && lp.order.length > 0) {
      const posMap = {};
      (facts.facts.recentLineups || []).forEach(l =>
        l.order.forEach(o => { if (o.name && o.pos) posMap[o.name] = o.pos; })
      );
      const posCount = {};
      const POSITIONS = ['一','二','三','遊','左','中','右','捕'];
      for (const o of lp.order) {
        const pos = posMap[o.name] || '';
        for (const ch of POSITIONS) {
          if (pos.includes(ch)) {
            posCount[ch] = (posCount[ch] || 0) + 1;
            break;
          }
        }
      }
      const dup = Object.entries(posCount).filter(([_, v]) => v > 1).map(([k]) => k);
      if (dup.length > 0) {
        console.error(`[build_game] lineup_proposal 守備被り検出 (${dup.join('/')}) → 提案を無効化`);
        generated.preview.lineup_proposal = null;
      }
    }
  } else if (status !== 'final') {
    console.error(`[build_game] Status="${status}", AI ${hasExistingPreview ? 'preview cached' : 'skipped (no starter info)'}.`);
  }

  // STEP4: 統合
  const gameJson = assembleGameJson(date, facts, generated, prev);

  if (dry) {
    console.log(JSON.stringify(gameJson, null, 2));
    return;
  }

  // STEP5: ファイル書き出し
  await fs.mkdir(GAMES_DIR, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(gameJson, null, 2) + '\n', 'utf8');
  console.error(`[build_game] Wrote ${outPath} (status=${gameJson.status})`);

  // STEP6: 直近成績(調子)の再集計
  // carp_batting が更新された可能性があるので recent_form.json を作り直す。
  // 失敗しても build 自体は成功扱い（調子表示は付加機能）。
  try {
    const formScript = path.join(__dirname, 'build_recent_form.mjs');
    const r = runNode(formScript, [date, '--games', '6']);
    if (r.status === 0) {
      console.error('[build_game] recent_form.json updated');
    } else {
      console.error(`[build_game] build_recent_form failed (non-fatal):\n${r.stderr}`);
    }
  } catch (e) {
    console.error(`[build_game] build_recent_form error (non-fatal): ${e.message}`);
  }
}

main().catch((e) => {
  console.error(`[build_game] ERROR: ${e.message}`);
  process.exit(1);
});
