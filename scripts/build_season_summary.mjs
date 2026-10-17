// シーズン総括データを生成する。全 final 試合を集計し、成績・月別推移・ハイライト・
// 選手成績を算出 → AIで「今季の物語」を生成 → games/season_summary_{year}.json に出力。
//
// 使い方:
//   node scripts/build_season_summary.mjs [year]   (省略時は最新シーズン)
//   node scripts/build_season_summary.mjs --dry     (ファイル書かず stdout)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(REPO_ROOT, 'games');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const yearArg = args.find(a => /^\d{4}$/.test(a));

function carpSide(g) {
  const carpHome = g.home_team === '広島';
  const cs = carpHome ? g.home_score : g.away_score;
  const os = carpHome ? g.away_score : g.home_score;
  const opp = carpHome ? g.away_team : g.home_team;
  return { carpHome, cs, os, opp };
}

async function loadFinalGames(year) {
  const files = (await fs.readdir(GAMES_DIR))
    .filter(fn => new RegExp(`^${year}-\\d{2}-\\d{2}\\.json$`).test(fn))
    .sort();
  const games = [];
  for (const fn of files) {
    try {
      const g = JSON.parse(await fs.readFile(path.join(GAMES_DIR, fn), 'utf8'));
      if (g.status !== 'final') continue;
      if (g.away_score == null || g.home_score == null) continue;
      games.push(g);
    } catch { /* skip */ }
  }
  return games;
}

function aggregate(games) {
  let w = 0, l = 0, d = 0, rs = 0, ra = 0;
  const monthly = {};
  let curStreakType = null, curStreak = 0, longestWin = 0, longestLose = 0;
  const allGames = [];
  let biggestWin = null, highestScoring = null, worstLoss = null;

  // 選手集計
  const bat = {};   // name -> {ab,h,hr,rbi,r,bb,k,double,triple,sb}
  const pit = {};   // name -> {outs,runs,er,k,bb,wins,losses,saves,hr}

  for (const g of games) {
    const { cs, os, opp } = carpSide(g);
    const date = g.game_date;
    const month = date.slice(5, 7);
    monthly[month] = monthly[month] || { w: 0, l: 0, d: 0 };
    rs += cs; ra += os;
    let r;
    if (cs > os) { w++; monthly[month].w++; r = 'W'; }
    else if (cs < os) { l++; monthly[month].l++; r = 'L'; }
    else { d++; monthly[month].d++; r = 'D'; }

    // 連勝連敗
    if (r === 'D') { /* 引き分けは連続を途切れさせない扱いにする */ }
    else if (r === curStreakType) { curStreak++; }
    else { curStreakType = r; curStreak = 1; }
    if (curStreakType === 'W') longestWin = Math.max(longestWin, curStreak);
    if (curStreakType === 'L') longestLose = Math.max(longestLose, curStreak);

    // ハイライト
    const margin = cs - os;
    if (r === 'W' && (!biggestWin || margin > biggestWin.margin)) biggestWin = { date, cs, os, opp, margin };
    if (!highestScoring || cs > highestScoring.cs) highestScoring = { date, cs, os, opp };
    if (r === 'L' && (!worstLoss || (os - cs) > worstLoss.margin)) worstLoss = { date, cs, os, opp, margin: os - cs };

    const title = (Array.isArray(g.title_candidates) && g.title_candidates[0]) || '';
    allGames.push({ date, result: r, carpScore: cs, oppScore: os, opponent: opp, resultLabel: g.result_label || '', title });

    // 打撃
    for (const b of (g.carp_batting || [])) {
      if (!b.name) continue;
      const e = bat[b.name] = bat[b.name] || { ab: 0, h: 0, hr: 0, rbi: 0, r: 0, bb: 0, k: 0, double: 0, triple: 0, sb: 0, g: 0 };
      e.ab += b.ab || 0; e.h += b.h || 0; e.hr += b.hr || 0; e.rbi += b.rbi || 0;
      e.r += b.r || 0; e.bb += b.bb || 0; e.k += b.k || 0;
      e.double += b.double || 0; e.triple += b.triple || 0; e.sb += b.sb || 0;
      if ((b.ab || 0) > 0 || (b.bb || 0) > 0) e.g++;
    }
    // 投手
    for (const p of (g.carp_pitching || [])) {
      if (!p.name) continue;
      const e = pit[p.name] = pit[p.name] || { outs: 0, runs: 0, er: 0, k: 0, bb: 0, wins: 0, losses: 0, saves: 0, hr: 0, g: 0 };
      e.outs += p.outs || 0; e.runs += p.runs || 0; e.er += p.earnedRuns || 0;
      e.k += p.strikeouts || 0; e.bb += p.walks || 0; e.hr += p.hrAllowed || 0; e.g++;
      if (p.result === 'win') e.wins++;
      if (p.result === 'loss') e.losses++;
      if (p.result === 'save') e.saves++;
    }
  }

  const monthlyArr = Object.keys(monthly).sort().map(m => ({ month: m, ...monthly[m] }));

  return {
    record: { w, l, d, games: games.length, pct: (w + l) > 0 ? (w / (w + l)) : 0 },
    runs: { scored: rs, allowed: ra, diff: rs - ra },
    streaks: { longestWin, longestLose },
    monthly: monthlyArr,
    highlights: { biggestWin, highestScoring, worstLoss },
    allGames,
  };
}

// nf3 の今季成績（打者・投手）から規定準拠のリーダーボードを作る。
// 規定打席 = 試合数×3.1、規定投球回 = 試合数×1.0。
// 打率は規定到達者のみ。本塁打・打点は全選手（計数部門は規定不要）。
// 投手は先発陣（防御率順・規定到達マーク）と救援陣（ホールド+セーブ順）に分ける。
function ipToOuts(ipStr) {
  // "143.1" = 143回1/3 → outs。小数部 .1=1アウト .2=2アウト
  if (!ipStr) return 0;
  const m = String(ipStr).match(/^(\d+)(?:\.(\d))?$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3 + (m[2] ? parseInt(m[2], 10) : 0);
}
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

async function buildLeaders(teamGames) {
  const kiteiPA = Math.round(teamGames * 3.1);
  const kiteiIP = teamGames; // 規定投球回 = 試合数
  let batters = [], pitchers = [];
  try {
    const bd = JSON.parse(await fs.readFile(path.join(GAMES_DIR, 'nf3_carp_batters.json'), 'utf8'));
    batters = (Array.isArray(bd) ? bd : bd.batters || []).map(b => ({ name: b.name, ...(b.career || {}) }));
  } catch { /* 無ければ空 */ }
  try {
    const pd = JSON.parse(await fs.readFile(path.join(GAMES_DIR, 'nf3_carp_pitchers.json'), 'utf8'));
    pitchers = pd.pitchers || [];
  } catch { /* 無ければ空 */ }

  // 打者
  const avgLeaders = batters
    .filter(b => (b.pa || 0) >= kiteiPA)
    .sort((a, b) => num(b.avg) - num(a.avg))
    .slice(0, 5)
    .map(b => ({ name: b.name, avg: b.avg, hr: b.hr, rbi: b.rbi, ops: b.ops, pa: b.pa, qualified: true }));
  const hrLeaders = batters
    .filter(b => (b.hr || 0) > 0)
    .sort((a, b) => (b.hr || 0) - (a.hr || 0))
    .slice(0, 5)
    .map(b => ({ name: b.name, hr: b.hr, rbi: b.rbi, avg: b.avg }));
  const rbiLeaders = batters
    .filter(b => (b.rbi || 0) > 0)
    .sort((a, b) => (b.rbi || 0) - (a.rbi || 0))
    .slice(0, 5)
    .map(b => ({ name: b.name, rbi: b.rbi, hr: b.hr, avg: b.avg }));

  // 投手: 先発陣（先発10以上）/ 救援陣（救援15以上）
  const withIp = pitchers.map(p => ({ ...p, _outs: ipToOuts(p.ip), _era: num(p.era) }));
  const starters = withIp
    .filter(p => (p.starts || 0) >= 10)
    .sort((a, b) => a._era - b._era)
    .slice(0, 6)
    .map(p => ({ name: p.name, era: p.era, ip: p.ip, wins: p.wins, losses: p.losses, starts: p.starts, qualified: p._outs >= kiteiIP * 3 }));
  const relievers = withIp
    .filter(p => (p.relief || 0) >= 15)
    .sort((a, b) => ((b.holds || 0) + (b.saves || 0)) - ((a.holds || 0) + (a.saves || 0)) || a._era - b._era)
    .slice(0, 6)
    .map(p => ({ name: p.name, era: p.era, ip: p.ip, games: p.relief, holds: p.holds, saves: p.saves }));

  return {
    kiteiPA, kiteiIP,
    batting: { avg: avgLeaders, hr: hrLeaders, rbi: rbiLeaders },
    pitching: { starters, relievers },
    source: (batters.length || pitchers.length) ? 'nf3' : 'none',
  };
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, temperature: 0.5, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data?.content?.[0]?.text || '').trim();
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const c = fence ? fence[1] : text;
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  return JSON.parse(c.slice(s, e + 1));
}

async function generateNarrative(agg, games, leaders) {
  // 月別 team_analysis.issues を集めて「シーズンを通じた課題」の素材にする
  const monthlyThemes = {};
  for (const g of games) {
    const m = g.game_date.slice(5, 7);
    const issues = (g.team_analysis?.issues || []).slice(0, 1);
    if (issues.length) { monthlyThemes[m] = monthlyThemes[m] || []; monthlyThemes[m].push(issues[0]); }
  }
  const themeSample = Object.keys(monthlyThemes).sort()
    .map(m => `${m}月: ${monthlyThemes[m].slice(0, 3).join(' / ')}`).join('\n');

  const prompt = `あなたは広島東洋カープを長年見続けているベテランファンライターです。
2026年シーズンのカープを総括する文章を書いてください。事実データに基づき、脚色はせず、しかし今季カープが何に取り組み何が課題だったかを物語として描いてください。

【今季成績】
${agg.record.w}勝${agg.record.l}敗${agg.record.d}分（勝率${agg.record.pct.toFixed(3)}）
総得点${agg.runs.scored} / 総失点${agg.runs.allowed}（得失点差${agg.runs.diff}）
最長連勝${agg.streaks.longestWin} / 最長連敗${agg.streaks.longestLose}

【月別成績】
${agg.monthly.map(m => `${m.month}月: ${m.w}勝${m.l}敗${m.d}分`).join('\n')}

【月別に挙がった課題（team_analysis より抜粋）】
${themeSample}

【打率（規定打席到達者）】
${(leaders.batting.avg || []).map(b => `${b.name}: 打率${b.avg} ${b.hr}本 ${b.rbi}打点`).join('\n') || '規定到達者なし'}
【本塁打】
${(leaders.batting.hr || []).map(b => `${b.name}: ${b.hr}本`).join(' / ')}
【打点】
${(leaders.batting.rbi || []).map(b => `${b.name}: ${b.rbi}点`).join(' / ')}

【先発投手】
${(leaders.pitching.starters || []).map(p => `${p.name}: 防御率${p.era} ${p.ip}回 ${p.wins}勝${p.losses}敗${p.qualified ? '（規定到達）' : ''}`).join('\n')}
【救援投手】
${(leaders.pitching.relievers || []).map(p => `${p.name}: 防御率${p.era} ${p.games}登板 ${p.holds || 0}H${p.saves || 0}S`).join('\n')}

【出力JSON（これだけを返す。コードブロック不要）】
{
  "title": "<今季を一言で表すタイトル、25字以内>",
  "overview": "<今季全体の総括、200字以内。順位争い・チームの状態・1年の流れを事実ベースで>",
  "themes": [
    {"theme": "<今季取り組んだテーマ、15字以内>", "detail": "<そのテーマの進捗と結果、80字以内。前進したか課題が残ったか>"}
  ],
  "turning_point": "<今季の分岐点、100字以内。流れが変わった時期や要因を月別成績から>",
  "next_season": "<来季への問い、60字以内。今季の課題を踏まえ「〜か」で終える>"
}

【ルール】
- themes は3〜4個。月別の課題から一貫したテーマを抽出する（例: 打線の得点力、先発の安定、若手の育成、救援の整備 など）
- 断定を避け、首脳陣の意図は可能性として書く
- 勝率${agg.record.pct.toFixed(3)}という結果を直視しつつ、単なる反省文でなく「何に取り組んだ1年か」を描く`;

  const raw = await callClaude(prompt);
  return extractJson(raw);
}

async function main() {
  const years = (await fs.readdir(GAMES_DIR))
    .map(fn => (fn.match(/^(\d{4})-\d{2}-\d{2}\.json$/) || [])[1])
    .filter(Boolean);
  const year = yearArg || (years.length ? years.sort().reverse()[0] : String(new Date().getFullYear()));

  console.error(`[season] aggregating ${year}...`);
  const games = await loadFinalGames(year);
  if (games.length === 0) { console.error('[season] no final games'); process.exit(1); }
  const agg = aggregate(games);
  console.error(`[season] ${agg.record.w}W ${agg.record.l}L ${agg.record.d}D / ${games.length} games`);

  const leaders = await buildLeaders(agg.record.games);
  console.error(`[season] leaders source: ${leaders.source} (規定打席${leaders.kiteiPA}/規定投球回${leaders.kiteiIP})`);

  let narrative = null;
  if (ANTHROPIC_API_KEY) {
    console.error('[season] generating narrative...');
    try { narrative = await generateNarrative(agg, games, leaders); }
    catch (e) { console.error(`[season] narrative failed: ${e.message}`); }
  } else {
    console.error('[season] ANTHROPIC_API_KEY not set — skipping narrative');
  }

  const out = {
    year: Number(year),
    generatedAt: new Date().toISOString(),
    period: { first: games[0].game_date, last: games[games.length - 1].game_date },
    ...agg,
    leaders,
    narrative,
  };

  if (dry) { console.log(JSON.stringify(out, null, 2)); return; }
  const outPath = path.join(GAMES_DIR, `season_summary_${year}.json`);
  await fs.writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.error(`[season] Wrote ${outPath}`);
}

main().catch(e => { console.error(`[season] ERROR: ${e.message}`); process.exit(1); });
