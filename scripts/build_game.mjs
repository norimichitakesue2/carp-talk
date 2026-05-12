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
    _meta: {
      sourceFetchedAt: factsRoot.fetchedAt,
      generatedAt: new Date().toISOString(),
      sourceUrl: `https://npb.jp/scores/${date.slice(0,4)}/${date.slice(5,7)}${date.slice(8,10)}/${factsRoot.segment}/`,
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
}

main().catch((e) => {
  console.error(`[build_game] ERROR: ${e.message}`);
  process.exit(1);
});
