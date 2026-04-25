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

function assembleGameJson(date, factsRoot, generated) {
  const f = factsRoot.facts;
  const ls = f.lineScore || {};
  const carpIsHome = !!f.carpIsHome;

  const homeTeam = ls.home?.team || (carpIsHome ? '広島' : '');
  const awayTeam = ls.away?.team || (carpIsHome ? '' : '広島');
  const homeScore = ls.home?.total ?? 0;
  const awayScore = ls.away?.total ?? 0;

  // games/*.json の innings オブジェクト形式に変換
  const inningsObj = {};
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

  // 投手リスト：勝/敗/セーブ + 先発を pitcher chips に
  const pitchers = [];
  const pp = f.pitchers || {};
  const winnerTeam = (homeScore > awayScore) ? homeTeam : awayTeam;
  const loserTeam  = (homeScore > awayScore) ? awayTeam : homeTeam;
  if (pp.winningPitcher) pitchers.push({ team: winnerTeam, role: '先発', name: pp.winningPitcher, result: 'win' });
  if (pp.losingPitcher)  pitchers.push({ team: loserTeam, role: '先発', name: pp.losingPitcher,  result: 'loss' });
  if (pp.savePitcher)    pitchers.push({ team: winnerTeam, role: '抑え', name: pp.savePitcher,   result: 'save' });

  // moments の id 連番化
  const moments = (generated.moments || []).map((m, i) => ({ id: i + 1, ...m }));

  const positives = (generated.positives || []).map((p, i) => ({
    ...p,
    id: p.id || `p_${date.replaceAll('-', '')}_${i + 1}`,
  }));

  let resultLabel = '';
  if (homeScore !== awayScore) {
    const winner = homeScore > awayScore ? homeTeam : awayTeam;
    resultLabel = `${winner}勝利`;
  } else {
    resultLabel = '引き分け';
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
    away_score: awayScore,
    home_score: homeScore,
    venue: f.venue || (carpIsHome ? 'マツダスタジアム' : ''),
    start_time: f.startTime || '',
    status: f.status || 'final',
    result_label: resultLabel,
    away_pitcher: awayPitcher,
    home_pitcher: homePitcher,
    title_candidates: generated.title_candidates || [],
    positives,
    turning_suggestions: generated.turning_suggestions || [],
    innings: inningsObj,
    pitchers,
    moments,
    players: (f.carpLineup || []).map((p) => ({ name: p.name, pos: p.pos || '?' })),
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

  if (facts?.facts?.status !== 'final') {
    console.error(`[build_game] Game status is "${facts?.facts?.status}", not final. Skip.`);
    process.exit(2);
  }

  // STEP2: AI生成（または空）
  let generated = { title_candidates: [], moments: [], turning_suggestions: [], positives: [] };
  if (!noAi) {
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
  }

  // STEP3: 統合
  const gameJson = assembleGameJson(date, facts, generated);

  if (dry) {
    console.log(JSON.stringify(gameJson, null, 2));
    return;
  }

  // STEP4: ファイル書き出し
  await fs.mkdir(GAMES_DIR, { recursive: true });
  const outPath = path.join(GAMES_DIR, `${date}.json`);

  let prev = null;
  try { prev = JSON.parse(await fs.readFile(outPath, 'utf8')); } catch { /* not existing */ }
  if (prev?._meta?.manuallyEdited) {
    console.error(`[build_game] ${outPath} is manually edited; skipping overwrite.`);
    process.exit(0);
  }

  await fs.writeFile(outPath, JSON.stringify(gameJson, null, 2) + '\n', 'utf8');
  console.error(`[build_game] Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(`[build_game] ERROR: ${e.message}`);
  process.exit(1);
});
