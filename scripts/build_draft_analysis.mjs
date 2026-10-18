// ドラフト戦略ページ用の分析データを生成する。
// 入力:
//   games/YYYY-MM-DD.json        … 各試合のボックス（打順・守備位置・投手継投）
//   games/npb_official_2026.json … NPB公式の確定成績（チーム・カープ個人）
//   games/npb_positions_2026.json… NPB公式のセ6球団 守備位置別出場・他5球団の打撃・カープ名簿（生年月日）
//   games/npb_farm_carp.json     … 2軍成績（参考）
// 出力: games/draft_analysis_2026.json
//
// 使い方:
//   node scripts/build_draft_analysis.mjs            （AIで「必要な選手タイプ」を生成）
//   node scripts/build_draft_analysis.mjs --skip-ai  （数値分析のみ・既存のAI文を再利用）

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMES_DIR = path.join(path.resolve(__dirname, '..'), 'games');
const YEAR = 2026;
const NEXT_SEASON_START = '2027-04-01'; // 年齢は来季開幕時点
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const args = process.argv.slice(2);
const skipAi = args.includes('--skip-ai');

const readJson = async f => JSON.parse(await fs.readFile(path.join(GAMES_DIR, f), 'utf8'));
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const f3 = v => (isFinite(v) ? v.toFixed(3).replace(/^0/, '') : '-');
const ipToOuts = s => { const m = String(s).match(/^(\d+)(?:\.(\d))?$/); return m ? (+m[1]) * 3 + (m[2] ? +m[2] : 0) : 0; };
const outsToIp = o => `${Math.floor(o / 3)}${o % 3 ? '.' + (o % 3) : ''}`;
const ageAt = (birth, ref = NEXT_SEASON_START) => {
  if (!birth) return null;
  const [by, bm, bd] = birth.split('-').map(Number), [ry, rm, rd] = ref.split('-').map(Number);
  return ry - by - ((rm < bm || (rm === bm && rd < bd)) ? 1 : 0);
};

const POS = [
  { key: '捕手', short: '捕', box: '捕' },
  { key: '一塁手', short: '一', box: '一' },
  { key: '二塁手', short: '二', box: '二' },
  { key: '三塁手', short: '三', box: '三' },
  { key: '遊撃手', short: '遊', box: '遊' },
  { key: '外野手', short: '外', box: '左中右' },
];
const TEAMS = ['阪神', '巨人', 'DeNA', '広島', 'ヤクルト', '中日'];

// ---------- 打順別・守備位置別（カープのボックスから。打席単位で正確） ----------
function boxSplits(games) {
  const z = () => ({ ab: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, hbp: 0, sf: 0, players: {} });
  const add = (e, b) => {
    e.ab += b.ab || 0; e.h += b.h || 0; e.d += b.double || 0; e.t += b.triple || 0; e.hr += b.hr || 0;
    e.bb += b.bb || 0; e.hbp += b.hbp || 0; e.sf += b.sf || 0;
    const pa = (b.ab || 0) + (b.bb || 0) + (b.hbp || 0) + (b.sf || 0);
    if (b.name && pa) e.players[b.name] = (e.players[b.name] || 0) + pa;
  };
  const fin = e => {
    const pa = e.ab + e.bb + e.hbp + e.sf;
    const obp = (e.h + e.bb + e.hbp) / (pa || 1), slg = (e.h + e.d + 2 * e.t + 3 * e.hr) / (e.ab || 1);
    const top = Object.entries(e.players).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, pa]) => ({ name, pa }));
    return { pa, avg: f3(e.h / (e.ab || 1)), obp: f3(obp), slg: f3(slg), ops: f3(obp + slg), hr: e.hr, top };
  };
  const line = {}, pos = {};
  for (const g of games) {
    for (const b of (g.carp_batting || [])) {
      if (b.line) add(line[b.line] = line[b.line] || z(), b);
      const m = String(b.pos || '').match(/[捕一二三遊左中右指]/); // 代打・代走後に就いた最初の守備位置
      if (m) add(pos[m[0]] = pos[m[0]] || z(), b);
    }
  }
  return {
    lineup: Object.keys(line).map(Number).sort((a, b) => a - b).filter(k => k <= 9).map(k => ({ slot: k, ...fin(line[k]) })),
    positionsBox: Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, fin(v)])),
  };
}

// ---------- セ6球団のポジション別OPS（公式：守備出場試合数で加重した打者OPS） ----------
function leaguePositions(posData, official) {
  const batting = { ...posData.batting };
  batting['広島'] = official.carp.batters.map(b => ({ ...b, double: b.double, triple: b.triple }));
  const out = {};
  for (const team of TEAMS) {
    out[team] = {};
    const bat = batting[team] || [];
    for (const P of POS) {
      const list = (posData.fielding[team]?.[P.key] || []).filter(x => x.g > 0);
      let wsum = 0, gsum = 0;
      const players = [];
      for (const f of list) {
        const b = bat.find(x => x.name === f.name);
        if (!b || !b.pa) continue;
        const ops = num(b.obp) + num(b.slg);
        wsum += ops * f.g; gsum += f.g;
        players.push({ name: f.name, g: f.g, ops: f3(ops), avg: b.avg, hr: b.hr, pa: b.pa });
      }
      players.sort((a, b) => b.g - a.g);
      out[team][P.key] = { ops: gsum ? wsum / gsum : null, regulars: players.slice(0, 3) };
    }
  }
  // 順位とリーグ平均（広島を除く5球団平均）
  const result = [];
  for (const P of POS) {
    const vals = TEAMS.map(t => ({ team: t, ops: out[t][P.key].ops })).filter(x => x.ops != null);
    vals.sort((a, b) => b.ops - a.ops);
    const carp = vals.find(v => v.team === '広島');
    const others = vals.filter(v => v.team !== '広島');
    const avg = others.reduce((s, v) => s + v.ops, 0) / (others.length || 1);
    result.push({
      pos: P.key, short: P.short,
      carpOps: f3(carp?.ops), leagueAvgOps: f3(avg), diff: carp ? +(carp.ops - avg).toFixed(3) : null,
      rank: vals.findIndex(v => v.team === '広島') + 1,
      best: { team: vals[0].team, ops: f3(vals[0].ops), name: out[vals[0].team][P.key].regulars[0]?.name || '' },
      teams: vals.map(v => ({ team: v.team, ops: f3(v.ops), regular: out[v.team][P.key].regulars[0]?.name || '' })),
      carpRegulars: out['広島'][P.key].regulars,
    });
  }
  return result;
}

// ---------- 投手：先発/救援（ボックスの先頭投手=先発） ----------
function pitchingSplits(games, official) {
  const hand = {};
  for (const p of official.carp.pitchers) hand[p.name] = p.throws;
  const handOf = key => { const full = Object.keys(hand).find(n => n.startsWith(key)); return full ? hand[full] : null; };
  const z = () => ({ outs: 0, er: 0, so: 0, bb: 0, hr: 0, h: 0, g: 0 });
  const st = z(), rp = z(), byHand = { 右: z(), 左: z() };
  let qs = 0, gs = 0, w = 0, short = 0;
  const starters = {};
  for (const g of games) {
    const ps = g.carp_pitching || [];
    ps.forEach((p, i) => {
      const e = i === 0 ? st : rp;
      e.outs += p.outs || 0; e.er += p.earnedRuns || 0; e.so += p.strikeouts || 0; e.bb += p.walks || 0; e.hr += p.hrAllowed || 0; e.h += p.hitsAllowed || 0; e.g++;
      if (i === 0) {
        gs++;
        if ((p.outs || 0) >= 18 && (p.earnedRuns || 0) <= 3) qs++;
        if ((p.outs || 0) < 15) short++;
        const h = handOf(p.name); if (h) { const b = byHand[h]; b.outs += p.outs || 0; b.er += p.earnedRuns || 0; b.g++; }
        const s = starters[p.name] = starters[p.name] || { gs: 0, outs: 0, er: 0, qs: 0 };
        s.gs++; s.outs += p.outs || 0; s.er += p.earnedRuns || 0; if ((p.outs || 0) >= 18 && (p.earnedRuns || 0) <= 3) s.qs++;
      }
    });
  }
  const rate = e => ({
    ip: outsToIp(e.outs), era: e.outs ? (e.er * 27 / e.outs).toFixed(2) : '-',
    k9: e.outs ? (e.so * 27 / e.outs).toFixed(2) : '-', bb9: e.outs ? (e.bb * 27 / e.outs).toFixed(2) : '-', hr9: e.outs ? (e.hr * 27 / e.outs).toFixed(2) : '-',
    whip: e.outs ? ((e.h + e.bb) * 3 / e.outs).toFixed(2) : '-',
  });
  // リーグ比較（チーム投手全体）
  const teams = official.teams.map(t => { const o = ipToOuts(t.ip); return { team: t.team, era: num(t.era), k9: t.strikeouts * 27 / o, bb9: t.bbAllowed * 27 / o, hr9: t.hrAllowed * 27 / o }; });
  const rank = (k, high) => { const s = teams.slice().sort((a, b) => high ? b[k] - a[k] : a[k] - b[k]); return s.findIndex(t => t.team === '広島') + 1; };
  const lg = k => (teams.reduce((s, t) => s + t[k], 0) / teams.length).toFixed(2);
  return {
    starter: { gs, ...rate(st), qsRate: f3(qs / (gs || 1)).replace(/^\./, '0.'), qs, ipPerStart: outsToIp(Math.round(st.outs / (gs || 1))), shortStarts: short },
    reliever: { appearances: rp.g, ...rate(rp) },
    starterByHand: Object.fromEntries(Object.entries(byHand).map(([h, e]) => [h, { gs: e.g, ip: outsToIp(e.outs), era: e.outs ? (e.er * 27 / e.outs).toFixed(2) : '-' }])),
    starters: Object.entries(starters).sort((a, b) => b[1].gs - a[1].gs).slice(0, 8).map(([name, s]) => ({ name, hand: handOf(name), gs: s.gs, ip: outsToIp(s.outs), era: (s.er * 27 / (s.outs || 1)).toFixed(2), qs: s.qs })),
    league: {
      teamK9: { carp: teams.find(t => t.team === '広島').k9.toFixed(2), avg: lg('k9'), rank: rank('k9', true) },
      teamBB9: { carp: teams.find(t => t.team === '広島').bb9.toFixed(2), avg: lg('bb9'), rank: rank('bb9', false) },
      teamHR9: { carp: teams.find(t => t.team === '広島').hr9.toFixed(2), avg: lg('hr9'), rank: rank('hr9', false) },
      teamERA: { carp: teams.find(t => t.team === '広島').era.toFixed(2), avg: lg('era'), rank: rank('era', false) },
    },
  };
}

// ---------- 年齢構成 ----------
function ageStructure(posData, official, positions) {
  const roster = posData.carpRoster?.players || [];
  const byName = {};
  for (const r of roster) byName[r.name] = r;
  const find = n => byName[n] || roster.find(r => r.name.startsWith(n) || n.startsWith(r.name));
  // 野手：ポジションごとの主力（出場上位）＋年齢
  const fielders = positions.map(p => ({
    pos: p.pos,
    players: p.carpRegulars.map(x => ({ ...x, age: ageAt(find(x.name)?.birthdate) })),
  }));
  // 支配下の年齢分布（カテゴリ別）
  const buckets = { '〜23': 0, '24〜27': 0, '28〜31': 0, '32〜': 0 };
  const dist = {};
  for (const r of roster.filter(r => r.registration !== '育成')) {
    const a = ageAt(r.birthdate); if (a == null) continue;
    const b = a <= 23 ? '〜23' : a <= 27 ? '24〜27' : a <= 31 ? '28〜31' : '32〜';
    (dist[r.category] = dist[r.category] || { ...buckets })[b]++;
  }
  // 投手：先発・救援の主力の年齢
  const pitchers = official.carp.pitchers
    .filter(p => (p.starts || 0) >= 7 || (p.relief || 0) >= 25)
    .map(p => ({ name: p.name, role: (p.starts || 0) >= 7 ? '先発' : '救援', throws: p.throws, era: p.era, ip: p.ip, age: ageAt(find(p.name)?.birthdate) }))
    .sort((a, b) => (a.role === b.role ? 0 : a.role === '先発' ? -1 : 1) || ipToOuts(b.ip) - ipToOuts(a.ip));
  return { refDate: NEXT_SEASON_START, fielders, pitchers, distribution: dist, rosterCount: roster.filter(r => r.registration !== '育成').length };
}

// ---------- 数値ベースの優先度（AIなしでも出せる土台） ----------
function needScores(positions, pitching, ages) {
  const items = positions.map(p => {
    const regs = ages.fielders.find(f => f.pos === p.pos)?.players || [];
    const main = regs[0];
    const oldMain = main?.age != null && main.age >= 33;
    const young = regs.some(r => r.age != null && r.age <= 26 && r.g >= 30);
    let score = 0;
    score += Math.max(0, -(p.diff || 0)) * 100;      // OPS差 .010 → 1点
    score += (p.rank - 1) * 1.5;                     // 順位
    if (oldMain) score += 4;                         // 主力の高齢化
    if (!young) score += 2;                          // 若手の台頭がない
    return { kind: '野手', pos: p.pos, score: +score.toFixed(1), facts: { ops: p.carpOps, lgAvg: p.leagueAvgOps, rank: p.rank, mainAge: main?.age ?? null, main: main?.name || '', youngRegular: young } };
  });
  const st = pitching.starter;
  const stScore = Math.max(0, (num(st.era) - num(pitching.league.teamERA.avg))) * 6 + (1 - num(st.qsRate)) * 8 + (pitching.league.teamK9.rank - 1) * 1.2;
  items.push({ kind: '投手', pos: '先発投手', score: +stScore.toFixed(1), facts: { era: st.era, qsRate: st.qsRate, ipPerStart: st.ipPerStart, k9Rank: pitching.league.teamK9.rank } });
  const rp = pitching.reliever;
  const rpScore = Math.max(0, num(rp.era) - 3) * 6 + (pitching.league.teamK9.rank - 1) * 0.8;
  items.push({ kind: '投手', pos: '救援投手', score: +rpScore.toFixed(1), facts: { era: rp.era, k9: rp.k9, bb9: rp.bb9 } });
  return items.sort((a, b) => b.score - a.score);
}

// ---------- AI：必要な選手タイプ ----------
async function callClaude(prompt, maxTokens = 6000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0.4, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data?.content?.[0]?.text || '').trim();
}

async function generateStrategy(a, farm) {
  const posLines = a.positions.map(p => `${p.pos}: カープOPS ${p.carpOps}（セ${p.rank}位／他5球団平均 ${p.leagueAvgOps}、差 ${p.diff > 0 ? '+' : ''}${p.diff}）主に ${p.carpRegulars.map(r => `${r.name}${a.ages.fielders.find(f => f.pos === p.pos)?.players.find(x => x.name === r.name)?.age ?? '?'}歳(${r.g}試合 OPS${r.ops})`).join('・')}`).join('\n');
  const lineLines = a.lineup.map(l => `${l.slot}番: OPS ${l.ops}（出塁率${l.obp} 長打率${l.slg}）主に ${l.top.map(t => t.name).join('・')}`).join('\n');
  const st = a.pitching.starter, rp = a.pitching.reliever, lg = a.pitching.league;
  const pitLines = `先発: ${st.gs}試合 防御率${st.era} QS率${st.qsRate} 1登板平均${st.ipPerStart}回 5回未満降板${st.shortStarts}回 K/9 ${st.k9} BB/9 ${st.bb9}
先発（左右別）: 右腕 ${a.pitching.starterByHand['右']?.gs}先発 防御率${a.pitching.starterByHand['右']?.era} / 左腕 ${a.pitching.starterByHand['左']?.gs}先発 防御率${a.pitching.starterByHand['左']?.era}
救援: 防御率${rp.era} K/9 ${rp.k9} BB/9 ${rp.bb9}
チーム全体（セ6球団中）: 防御率${lg.teamERA.carp}（${lg.teamERA.rank}位）奪三振率${lg.teamK9.carp}（${lg.teamK9.rank}位）与四球率${lg.teamBB9.carp}（${lg.teamBB9.rank}位）被本塁打率${lg.teamHR9.carp}（${lg.teamHR9.rank}位）
主な投手と来季年齢: ${a.ages.pitchers.map(p => `${p.name}(${p.role}・${p.throws}・${p.age ?? '?'}歳・防${p.era})`).join(' / ')}`;
  const farmLines = farm ? `打者: ${(farm.batters || []).slice(0, 8).map(b => `${b.name} OPS${b.ops}`).join(' / ')}\n投手: ${(farm.pitchers || []).slice(0, 8).map(p => `${p.name} 防${p.era}`).join(' / ')}` : 'なし';
  const scoreLines = a.needScores.map(n => `${n.pos}: ${n.score}`).join(' / ');

  const prompt = `あなたは広島東洋カープを長年分析してきた編成担当の視点を持つ野球ライターです。2026年シーズンのデータから、今オフのドラフトでカープが獲得すべき選手タイプを提案してください。

【チーム】セ・リーグ${a.standing}位。打率・得点・OPSはリーグ最下位。守備率はリーグ1位。

【守備位置別の打力（NPB公式。守備出場試合数で加重した打者OPS）】
${posLines}

【打順別（今季の試合データ集計）】
${lineLines}

【投手陣】
${pitLines}

【2軍で規定到達した主な選手（9月時点・参考）】
${farmLines}

【数値ベースの優先度スコア（高いほど補強が急務）】
${scoreLines}

【出力JSON（これだけを返す。コードブロック不要）】
{
  "summary": "<今オフのドラフト方針の総論、150字以内>",
  "needs": [
    {"priority": 1, "type": "<求める選手像、20字以内。例: 長打力のある大卒外野手>", "pos": "<守備位置または先発/救援>", "profile": "<即戦力（大学・社会人）/ 将来の主力候補（高校生）/ どちらでも>", "traits": ["<特徴1>", "<特徴2>", "<特徴3>"], "why": "<なぜ必要か、上のデータを根拠に100字以内>"}
  ],
  "lineupIdeal": "<打順で特に補強したい役割（例: 2番・5番）とその理由、80字以内>",
  "caution": "<ドラフトだけでは埋まらない点・注意点、80字以内>"
}

【ルール】
- needs は4〜6個、priority 順。野手と投手の両方を検討し、データ上の弱点が大きい順に並べる
- 数値は上に書かれたものだけを引用する。推測で新しい数値を作らない
- 実在のドラフト候補選手の名前は書かない（求める選手のタイプまで）
- 守備位置の負担（捕手・遊撃・中堅は守備力も重要）や年齢構成（主力の高齢化）も考慮する
- 外国人補強やFAで埋めやすい枠（一塁・外野の長打など）と、ドラフトで育てるべき枠の違いにも触れてよい`;
  const raw = await callClaude(prompt);
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  return JSON.parse(raw.slice(s, e + 1));
}

async function main() {
  const files = (await fs.readdir(GAMES_DIR)).filter(f => new RegExp(`^${YEAR}-\\d{2}-\\d{2}\\.json$`).test(f)).sort();
  const games = [];
  for (const f of files) { const g = await readJson(f); if (g.status === 'final') games.push(g); }
  const official = await readJson(`npb_official_${YEAR}.json`);
  const posData = await readJson(`npb_positions_${YEAR}.json`);
  let farm = null; try { farm = await readJson('npb_farm_carp.json'); } catch { /* optional */ }

  const { lineup, positionsBox } = boxSplits(games);
  const positions = leaguePositions(posData, official);
  const pitching = pitchingSplits(games, official);
  const ages = ageStructure(posData, official, positions);
  const scores = needScores(positions, pitching, ages);
  const standing = official.teams.find(t => t.team === '広島').standing;

  const outPath = path.join(GAMES_DIR, `draft_analysis_${YEAR}.json`);
  let prev = null; try { prev = JSON.parse(await fs.readFile(outPath, 'utf8')); } catch { /* none */ }
  const out = {
    year: YEAR, generatedAt: new Date().toISOString(), games: games.length, standing,
    lineup, positionsBox, positions, pitching, ages, needScores: scores,
    farm: farm ? { fetchedAt: farm.fetchedAt, batters: (farm.batters || []).slice(0, 10), pitchers: (farm.pitchers || []).slice(0, 10) } : null,
    strategy: prev?.strategy || null,
    sources: ['NPB公式（npb.jp/bis/2026/stats/・選手名簿）', '各試合のボックススコア（打順別・先発/救援の集計）'],
  };
  if (ANTHROPIC_API_KEY && !skipAi) {
    console.error('[draft] generating strategy...');
    for (let i = 1; i <= 2; i++) {
      try { out.strategy = await generateStrategy(out, farm); break; }
      catch (e) { console.error(`[draft] strategy attempt ${i} failed: ${e.message}`); }
    }
  }
  await fs.writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.error(`[draft] wrote ${outPath}`);
  console.error(`[draft] 優先度: ${scores.map(s => `${s.pos}(${s.score})`).join(' > ')}`);
  if (out.strategy) console.error(`[draft] 方針: ${out.strategy.summary}`);
}

main().catch(e => { console.error(`[draft] ERROR: ${e.message}`); process.exit(1); });
