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

// NPB公式の確定成績（games/npb_official_{year}.json）。あればこちらを最優先で使う。
async function loadOfficial(year) {
  try { return JSON.parse(await fs.readFile(path.join(GAMES_DIR, `npb_official_${year}.json`), 'utf8')); }
  catch { return null; }
}

function buildLeadersFromOfficial(off) {
  const { kiteiPA, kiteiIP } = off;
  const B = off.carp.batters, P = off.carp.pitchers;
  const lr = (name, item) => (off.carp.leagueRanks || []).find(r => r.name === name && r.item === item);
  const avg = B.filter(b => b.pa >= kiteiPA).sort((a, b) => num(b.avg) - num(a.avg)).slice(0, 5)
    .map(b => ({ name: b.name, avg: b.avg, hr: b.hr, rbi: b.rbi, ops: b.ops, pa: b.pa, qualified: true, leagueRank: lr(b.name, '打率')?.rank || null }));
  const hr = B.filter(b => b.hr > 0).sort((a, b) => b.hr - a.hr).slice(0, 5).map(b => ({ name: b.name, hr: b.hr, rbi: b.rbi, avg: b.avg }));
  const rbi = B.filter(b => b.rbi > 0).sort((a, b) => b.rbi - a.rbi).slice(0, 5).map(b => ({ name: b.name, rbi: b.rbi, hr: b.hr, avg: b.avg }));
  const withO = P.map(p => ({ ...p, _outs: ipToOuts(p.ip), _era: num(p.era) }));
  const starters = withO.filter(p => (p.starts || 0) >= 7).sort((a, b) => a._era - b._era).slice(0, 7)
    .map(p => ({ name: p.name, era: p.era, ip: p.ip, wins: p.w, losses: p.l, starts: p.starts, qualified: p._outs >= kiteiIP * 3, leagueRank: lr(p.name, '防御率')?.rank || null }));
  const relievers = withO.filter(p => (p.relief || 0) >= 25).sort((a, b) => (b.hp + b.sv) - (a.hp + a.sv) || a._era - b._era).slice(0, 7)
    .map(p => ({ name: p.name, era: p.era, ip: p.ip, games: p.relief, holds: p.hld, saves: p.sv, hp: p.hp }));
  return { kiteiPA, kiteiIP, batting: { avg, hr, rbi }, pitching: { starters, relievers }, source: 'npb' };
}

// チーム主要指標とセ・リーグ内順位
function buildLeague(off) {
  const carp = off.teams.find(t => t.team === '広島');
  const ranks = off.ranks['広島'];
  const metrics = off.metricDefs.map(m => ({
    ...m, value: carp[m.key], rank: ranks[m.key],
    best: (() => { // リーグ1位の値
      const vals = off.teams.map(t => num(t[m.key]));
      const v = m.higherIsBetter ? Math.max(...vals) : Math.min(...vals);
      const t = off.teams.find(tt => num(tt[m.key]) === v);
      return { team: t.team, value: t[m.key] };
    })(),
  }));
  return {
    standing: carp.standing, gb: carp.gb,
    standings: off.teams.map(t => ({ team: t.team, w: t.w, l: t.l, d: t.d, pct: t.pct, gb: t.gb, standing: t.standing })),
    metrics, vs: off.carpVs, source: off.source,
  };
}

// 試合ボックス（姓のみ表記）から選手ごとの月別推移と印象的な試合を集める
function buildPlayerTimeline(games, officialNames) {
  // 公式フルネーム → ボックスの姓キー（一意に対応するもののみ）
  const boxNames = new Set();
  for (const g of games) {
    for (const b of (g.carp_batting || [])) b.name && boxNames.add(b.name);
    for (const p of (g.carp_pitching || [])) p.name && boxNames.add(p.name);
  }
  // 各公式名に最長一致のボックス姓を割り当て、同じ姓が複数人に割り当たったものは除外
  const bestOf = {};
  for (const full of officialNames) {
    const cands = [...boxNames].filter(k => full.startsWith(k));
    if (cands.length) bestOf[full] = cands.sort((a, b) => b.length - a.length)[0];
  }
  const keyOf = {};
  for (const [full, k] of Object.entries(bestOf)) {
    if (Object.values(bestOf).filter(x => x === k).length === 1) keyOf[full] = k;
  }
  // タイトル中の名前一致：フルネーム一致、または姓の直後が漢字でない（=別人の長い姓の一部でない）
  const han = /\p{Script=Han}/u;
  const mentions = (title, key, full) => {
    if (title.includes(full)) return true;
    let i = title.indexOf(key);
    while (i >= 0) {
      const next = title[i + key.length];
      if (!next || !han.test(next)) return true;
      i = title.indexOf(key, i + 1);
    }
    return false;
  };
  const tl = {};
  for (const full of Object.keys(keyOf)) tl[full] = { bat: {}, pit: {}, moments: [], turnings: [], gameSnips: {} };
  for (const g of games) {
    const m = g.game_date.slice(5, 7);
    for (const [full, key] of Object.entries(keyOf)) {
      const b = (g.carp_batting || []).find(x => x.name === key);
      if (b) { const e = tl[full].bat[m] = tl[full].bat[m] || { ab: 0, h: 0, hr: 0, rbi: 0 }; e.ab += b.ab || 0; e.h += b.h || 0; e.hr += b.hr || 0; e.rbi += b.rbi || 0; }
      const p = (g.carp_pitching || []).find(x => x.name === key);
      if (p) { const e = tl[full].pit[m] = tl[full].pit[m] || { outs: 0, er: 0, g: 0 }; e.outs += p.outs || 0; e.er += p.earnedRuns || 0; e.g++; }
      // 印象的な場面（positives のタイトルに名前が出たもの。長い姓との誤マッチは除外）
      for (const pos of (g.positives || [])) {
        const t = pos.title || '';
        if (mentions(t, key, full)) tl[full].moments.push({ date: g.game_date, title: t });
      }
      // 試合ごとの場面スニペット（救った/痛かった判定用。重複はAI側で統合）
      {
        const sn = [];
        for (const pos of (g.positives || [])) { const t = `${pos.title || ''}。${pos.desc || ''}`; if (mentions(t, key, full)) sn.push(`好プレー: ${t}`); }
        for (const mo of (g.moments || [])) { const t = `${mo.desc || ''}。${mo.sub || ''}`; if (mentions(t, key, full)) sn.push(`流れ(${mo.inning || ''}): ${t}`); }
        for (const ts of (g.turning_suggestions || [])) { const t = ts.description || ''; if (t && mentions(t, key, full)) sn.push(`分岐点(${ts.inning || ''}): ${t}`); }
        if (sn.length) {
          const { cs, os, opp } = carpSide(g);
          tl[full].gameSnips[g.game_date] = { result: cs > os ? 'W' : cs < os ? 'L' : 'D', score: `${cs}-${os}`, opp, snips: sn };
        }
      }
      // 分岐点（詳細ページの turning_suggestions）。主語が出やすい description で判定
      for (const ts of (g.turning_suggestions || [])) {
        const d = ts.description || '';
        if (d && mentions(d, key, full)) {
          const { cs, os } = carpSide(g);
          tl[full].turnings.push({ date: g.game_date, inning: ts.inning || '', description: d, reason: ts.reason || '', intensity: ts.intensity || 'mid', result: cs > os ? 'W' : cs < os ? 'L' : 'D', score: `${cs}-${os}` });
        }
      }
    }
  }
  const out = {};
  for (const [full, v] of Object.entries(tl)) {
    const bat = Object.keys(v.bat).sort().map(m => ({ month: m, ab: v.bat[m].ab, h: v.bat[m].h, hr: v.bat[m].hr, rbi: v.bat[m].rbi, avg: v.bat[m].ab ? (v.bat[m].h / v.bat[m].ab).toFixed(3).replace(/^0/, '') : '-' })).filter(x => x.ab > 0);
    const pit = Object.keys(v.pit).sort().map(m => ({ month: m, g: v.pit[m].g, ip: `${Math.floor(v.pit[m].outs / 3)}${v.pit[m].outs % 3 ? '.' + (v.pit[m].outs % 3) : ''}`, era: v.pit[m].outs ? (v.pit[m].er * 27 / v.pit[m].outs).toFixed(2) : '-' })).filter(x => x.g > 0);
    out[full] = { key: keyOf[full], monthlyBat: bat, monthlyPit: pit, moments: v.moments.slice(-40), turnings: v.turnings, gameSnips: v.gameSnips };
  }
  return out;
}

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

async function callClaude(prompt, maxTokens = 4096) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0.5, messages: [{ role: 'user', content: prompt }] }),
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

function pickMoments(moments, n) {
  if (moments.length <= n) return moments;
  const step = moments.length / n;
  return Array.from({ length: n }, (_, i) => moments[Math.floor(i * step)]);
}

// 「この選手のおかげで救われた/逆に痛かった」場面を試合ごとにAIで仕分けて数える
async function classifyPlayerScenes(name, key, isPitcher, gameSnips) {
  const dates = Object.keys(gameSnips).sort();
  if (!dates.length) return { saved: 0, hurt: 0, bigSaved: 0, bigHurt: 0, scenes: [] };
  const blocks = dates.map((d, i) => {
    const g = gameSnips[d];
    return `[G${i + 1}] ${d.slice(5)} ${g.result === 'W' ? '○' : g.result === 'L' ? '●' : '△'}${g.score} vs${g.opp}\n` + g.snips.map(x => `  - ${x}`).join('\n');
  }).join('\n');
  const prompt = `広島カープの${name}（試合記事での表記「${key}」・${isPitcher ? '投手' : '野手'}）について、2026年シーズンの各試合の記述から「${name}自身のプレーでチームが救われた場面（＋）」と「${name}自身のプレーがチームに痛かった場面（−）」を仕分けてください。

${blocks}

【判定ルール】
- ${name}自身の打撃・投球・守備・走塁が直接の原因になった場面だけを数える。他の選手が主役の場面、同じ姓の相手チーム選手の場面は除外
- ＋の例: 先制・同点・勝ち越し・逆転の打点、本塁打、好機を広げる出塁、無失点の好投、ピンチを抑える、好守備
- −の例: 好機での凡退・併殺・三振、決定的な失点・被弾、失点につながる四球、失策、走塁ミス
- 結果に関係しない普通の凡退・普通の登板は数えない
- 同じ試合で同じ場面が複数の記述に出ていても1つにまとめる（同じイニングの同じ出来事は1件）
- impact は勝敗に直結したら "big"（決勝打、サヨナラ、決勝点献上、逆転弾を浴びる等）、それ以外は "normal"
- summary は事実だけを25字以内で（数値は記述にあるものだけ）

【出力JSON（配列のみ・コードブロック不要）。場面のない試合は出力しない】
[{"g":"G番号","scenes":[{"sign":"+","inning":"5回表","impact":"normal","summary":"..."}]}]`;
  let arr = null;
  for (let attempt = 1; attempt <= 2 && !arr; attempt++) {
    try {
      const raw = await callClaude(prompt, 16000);
      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      arr = JSON.parse(raw.slice(s, e + 1));
    } catch (err) { console.error(`[season] scenes ${name} attempt ${attempt} failed: ${err.message}`); }
  }
  if (!arr) return null;
  const scenes = [];
  for (const row of arr) {
    const idx = parseInt(String(row.g || '').replace(/\D/g, ''), 10) - 1;
    const d = dates[idx]; if (!d) continue;
    const g = gameSnips[d];
    for (const sc of (row.scenes || [])) {
      if (sc.sign !== '+' && sc.sign !== '-' && sc.sign !== '−') continue;
      scenes.push({ date: d, inning: sc.inning || '', sign: sc.sign === '+' ? '+' : '-', impact: sc.impact === 'big' ? 'big' : 'normal', summary: sc.summary || '', result: g.result, score: g.score, opp: g.opp });
    }
  }
  const plus = scenes.filter(x => x.sign === '+'), minus = scenes.filter(x => x.sign === '-');
  return {
    saved: plus.length, hurt: minus.length,
    bigSaved: plus.filter(x => x.impact === 'big').length, bigHurt: minus.filter(x => x.impact === 'big').length,
    savedInWins: plus.filter(x => x.result === 'W').length, hurtInLosses: minus.filter(x => x.result === 'L').length,
    scenes,
  };
}

// 分岐点候補：strong→mid→weak の優先で、シーズン全体に散らして最大8件
function pickTurningCands(turnings) {
  const pri = { strong: 0, mid: 1, weak: 2 };
  const sorted = turnings.slice().sort((a, b) => (pri[a.intensity] ?? 1) - (pri[b.intensity] ?? 1));
  const top = sorted.filter(t => t.intensity !== 'weak');
  const pool = top.length >= 3 ? top : sorted;
  return pickMoments(pool.slice().sort((a, b) => a.date.localeCompare(b.date)), 8);
}

async function generatePlayerReviews(off, timeline, league, scenesMap = {}) {
  const B = off.carp.batters.filter(b => b.pa >= 150).sort((a, b) => b.pa - a.pa);
  const P = off.carp.pitchers.filter(p => (p.starts || 0) >= 7 || (p.relief || 0) >= 25).sort((a, b) => ipToOuts(b.ip) - ipToOuts(a.ip));
  const lr = name => (off.carp.leagueRanks || []).filter(r => r.name === name).map(r => `${r.item}リーグ${r.rank}位`).join('・');
  const mlabel = m => `${parseInt(m)}月`;
  const sceneText = n => { const r = scenesMap[n]; return r ? `\n  チームを救った場面${r.saved}（うち勝敗直結${r.bigSaved}）/ 痛かった場面${r.hurt}（うち勝敗直結${r.bigHurt}）※試合記事からの集計` : ''; };
  const candMap = {}; // name -> [cand]
  const candText = t => {
    const cands = pickTurningCands(t.turnings || []);
    if (!cands.length) return ' なし';
    return '\n' + cands.map((c, i) => `    T${i + 1} ${c.date.slice(5)} ${c.inning}［${c.result === 'W' ? '勝' : c.result === 'L' ? '敗' : '分'} ${c.score}］${c.description}（${c.reason.slice(0, 70)}）`).join('\n');
  };
  for (const p of [...off.carp.batters, ...off.carp.pitchers]) candMap[p.name] = pickTurningCands(timeline[p.name]?.turnings || []);

  const batLines = B.map(b => {
    const t = timeline[b.name] || {};
    const mon = (t.monthlyBat || []).map(x => `${mlabel(x.month)} ${x.avg}(${x.ab}打数)${x.hr ? ` ${x.hr}本` : ''}`).join(' / ');
    const mom = pickMoments(t.moments || [], 5).map(x => `${x.date.slice(5)} ${x.title}`).join(' / ');
    return `■${b.name}（${b.bats}打）${b.g}試合 ${b.pa}打席 打率${b.avg} ${b.hr}本 ${b.rbi}打点 ${b.sb}盗塁 OPS${b.ops} 出塁率${b.obp} 四球${b.bb} 三振${b.so}${b.pa >= off.kiteiPA ? '（規定到達）' : ''}${lr(b.name) ? ' ' + lr(b.name) : ''}
  月別(試合データ集計・参考): ${mon || 'なし'}
  印象的な場面: ${mom || 'なし'}${sceneText(b.name)}`;
  }).join('\n');
  const pitLines = P.map(p => {
    const t = timeline[p.name] || {};
    const mon = (t.monthlyPit || []).map(x => `${mlabel(x.month)} ${x.g}登板 防${x.era}`).join(' / ');
    const mom = pickMoments(t.moments || [], 5).map(x => `${x.date.slice(5)} ${x.title}`).join(' / ');
    const role = (p.starts || 0) >= 7 ? `先発${p.starts}${p.relief ? `・救援${p.relief}` : ''}` : `救援${p.relief}`;
    return `■${p.name}（${p.throws}投・${role}）${p.g}登板 ${p.w}勝${p.l}敗${p.sv}S${p.hld}H 防御率${p.era} ${p.ip}回 奪三振${p.so} 与四球${p.bb} 被本塁打${p.hr} WHIP${p.whip}${ipToOuts(p.ip) >= off.kiteiIP * 3 ? '（規定到達）' : ''}${lr(p.name) ? ' ' + lr(p.name) : ''}
  月別(試合データ集計・参考): ${mon || 'なし'}
  印象的な場面: ${mom || 'なし'}${sceneText(p.name)}`;
  }).join('\n');

  const rules = `【ルール】
- 数値は上の成績からのみ引用し、計算・推測で新しい数値を作らない。月別は「参考」なので傾向として触れる程度に
- 怪我・故障・不調の理由など、データにない事情は書かない。月別の出場が途切れている場合は「◯月以降は出場がない」など事実のみ
- 首脳陣の意図は断定せず可能性として書く
- 褒めるだけ・叩くだけにせず、良かった点と課題を両方書く
- チームは${league.standing}位（打率・得点・OPSはリーグ最下位）。チーム状況との関係にも触れてよい`;
  const fmt = `【出力JSON（配列のみ。コードブロック不要）】
[{"name":"<上と同じ表記>","tag":"<今季を表す短い見出し、12字以内>","review":"<今季の振り返り、130〜170字>","next":"<来季への期待・課題、45字以内>"}]`;

  const head = `あなたは広島東洋カープを長年見続けているベテランのファンライターです。2026年シーズンのカープの選手個人の振り返りを書いてください。成績はNPB公式の確定値です。`;
  const results = [];
  for (const [label, lines] of [['打者', batLines], ['投手', pitLines]]) {
    const prompt = `${head}\n\n【${label}の今季成績】\n${lines}\n\n${rules}\n\n${fmt}`;
    let arr = null;
    for (let attempt = 1; attempt <= 2 && !arr; attempt++) {
      try {
        const raw = await callClaude(prompt, 8192);
        const s = raw.indexOf('['), e = raw.lastIndexOf(']');
        arr = JSON.parse(raw.slice(s, e + 1));
      } catch (err) { console.error(`[season] ${label} review attempt ${attempt} failed: ${err.message}`); }
    }
    if (!arr) throw new Error(`${label} のレビュー生成に失敗`);
    results.push(...arr.map(x => ({ ...x, type: label === '打者' ? 'batter' : 'pitcher' })));
    console.error(`[season] player reviews (${label}): ${arr.length}`);
  }
  // 成績・月別を添えて返す
  return results.map(r => {
    const stat = r.type === 'batter' ? off.carp.batters.find(b => b.name === r.name) : off.carp.pitchers.find(p => p.name === r.name);
    const t = timeline[r.name] || {};
    const rest = r;
    const sc = scenesMap[r.name] || null;
    const scenes = sc ? { saved: sc.saved, hurt: sc.hurt, bigSaved: sc.bigSaved, bigHurt: sc.bigHurt, list: sc.scenes.slice().sort((a, b) => (a.impact === 'big' ? 0 : 1) - (b.impact === 'big' ? 0 : 1) || a.date.localeCompare(b.date)) } : null;
    return { ...rest, scenes, stat: stat || null, monthly: r.type === 'batter' ? (t.monthlyBat || []) : (t.monthlyPit || []), leagueRanks: (off.carp.leagueRanks || []).filter(x => x.name === r.name) };
  }).filter(r => r.stat);
}

async function generateNarrative(agg, games, leaders, league) {
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

【最終順位】セ・リーグ${league ? league.standing + '位（首位と' + league.gb + '差）' : '不明'}
【チーム主要指標とリーグ内順位（6球団中）】
${league ? league.metrics.map(m => `${m.label}${m.higherIsBetter ? '' : '(少ないほど上位)'}: ${m.value}（${m.rank}位）`).join(' / ') : 'なし'}
【対戦成績】${league ? Object.entries(league.vs).map(([k, v]) => `${k} ${v}`).join(' / ') : ''}

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
- 勝率${agg.record.pct.toFixed(3)}という結果を直視しつつ、単なる反省文でなく「何に取り組んだ1年か」を描く
- 数値は上に書かれたものだけを使う（リーグ順位・成績を推測で作らない）。守備率など良かった指標にも公平に触れる`;

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

  const off = await loadOfficial(year);
  if (off) {
    const t = off.teams.find(x => x.team === '広島');
    if (t && (t.w !== agg.record.w || t.l !== agg.record.l || t.d !== agg.record.d)) {
      console.error(`[season] ⚠️ 試合データ集計(${agg.record.w}-${agg.record.l}-${agg.record.d})とNPB公式(${t.w}-${t.l}-${t.d})が不一致。欠けている試合を確認してください`);
    }
  }
  const leaders = off ? buildLeadersFromOfficial(off) : await buildLeaders(agg.record.games);
  const league = off ? buildLeague(off) : null;
  console.error(`[season] leaders source: ${leaders.source} (規定打席${leaders.kiteiPA}/規定投球回${leaders.kiteiIP})`);

  // 既存ファイル（AI生成部分の再利用用）
  const outPath = path.join(GAMES_DIR, `season_summary_${year}.json`);
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(outPath, 'utf8')); } catch { /* none */ }
  const skipAi = args.includes('--skip-ai');

  let narrative = prev?.narrative || null;
  let players = prev?.players || [];
  if (ANTHROPIC_API_KEY && !skipAi) {
    console.error('[season] generating narrative...');
    try { narrative = await generateNarrative(agg, games, leaders, league); }
    catch (e) { console.error(`[season] narrative failed: ${e.message}`); }
    if (off) {
      console.error('[season] generating player reviews...');
      const names = [...off.carp.batters.map(b => b.name), ...off.carp.pitchers.map(p => p.name)];
      const timeline = buildPlayerTimeline(games, names);
      // 救った/痛かった場面の仕分け（キャッシュ: games/season_scenes_{year}.json、--refresh-scenes で作り直し）
      const scenesPath = path.join(GAMES_DIR, `season_scenes_${year}.json`);
      let scenesMap = {};
      try { if (!args.includes('--refresh-scenes')) scenesMap = JSON.parse(await fs.readFile(scenesPath, 'utf8')); } catch { /* none */ }
      const targets = [
        ...off.carp.batters.filter(b => b.pa >= 150).map(b => ({ name: b.name, pit: false })),
        ...off.carp.pitchers.filter(p => (p.starts || 0) >= 7 || (p.relief || 0) >= 25).map(p => ({ name: p.name, pit: true })),
      ];
      for (const t of targets) {
        if (scenesMap[t.name]) continue;
        const tlp = timeline[t.name]; if (!tlp) continue;
        const r = await classifyPlayerScenes(t.name, tlp.key, t.pit, tlp.gameSnips || {});
        if (r) { scenesMap[t.name] = r; console.error(`[season] scenes ${t.name}: 救った${r.saved} / 痛かった${r.hurt}`); }
        await fs.writeFile(scenesPath, JSON.stringify(scenesMap, null, 2) + '\n', 'utf8'); // 途中経過も保存
      }
      try { players = await generatePlayerReviews(off, timeline, league, scenesMap); }
      catch (e) { console.error(`[season] player reviews failed: ${e.message}`); }
    }
  } else {
    console.error('[season] AI生成をスキップ（既存の narrative / players を再利用）');
  }

  const out = {
    year: Number(year),
    generatedAt: new Date().toISOString(),
    period: { first: games[0].game_date, last: games[games.length - 1].game_date },
    ...agg,
    leaders,
    league,
    narrative,
    players,
  };

  if (dry) { console.log(JSON.stringify(out, null, 2)); return; }
  await fs.writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.error(`[season] Wrote ${outPath}`);
}

main().catch(e => { console.error(`[season] ERROR: ${e.message}`); process.exit(1); });
