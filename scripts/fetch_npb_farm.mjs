// NPB公式のファーム（ウエスタン・リーグ）個人成績から
// カープの2軍選手の打撃・投球成績を取得してキャッシュJSONに保存する。
//
// 出力: games/npb_farm_carp.json
//
// 使い方:
//   node scripts/fetch_npb_farm.mjs [--dry]
//
// カープのファームはウエスタン・リーグ所属。
//   個人打撃: https://npb.jp/bis/{year}/stats/bat_2w.html
//   個人投手: https://npb.jp/bis/{year}/stats/pit_2w.html
// 選手名は「ラミレス(広)」のように末尾にチーム略号。広島は (広)。
// 規定打席/規定投球回 以上の選手のみ掲載される点に注意（＝確かな実績ある選手）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(REPO_ROOT, 'games');

const UA = 'carp-talk-bot/0.1 (+https://carp-talk.vercel.app; fan-site, infrequent)';
const dry = process.argv.includes('--dry');
const YEAR = (() => {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.getUTCFullYear();
})();

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

const num = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
};
const intval = (v) => {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d\-]/g, ''), 10);
  return isNaN(n) ? null : n;
};

// "ラミレス(広)" → { name: "ラミレス", team: "広" }
function parsePlayerCell(text) {
  const t = (text || '').replace(/[\s　]/g, '');
  const m = t.match(/^(.+?)\(([^)]+)\)$/);
  if (m) return { name: m[1], team: m[2] };
  return { name: t, team: '' };
}

// 個人打撃（ウエスタン）からカープ選手を抽出
async function fetchFarmBatters() {
  const url = `https://npb.jp/bis/${YEAR}/stats/bat_2w.html`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  // 列: 順位|選手|打率|試合|打席|打数|得点|安打|二塁打|三塁打|本塁打|塁打|打点|
  //     盗塁|盗塁刺|犠打|犠飛|四球|故意四|死球|三振|併殺打|長打率|出塁率
  const out = [];
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('th, td').map((_, c) => $(c).text().trim()).get();
    if (cells.length < 24) return;
    const p = parsePlayerCell(cells[1]);
    if (p.team !== '広') return;
    out.push({
      name: p.name,
      avg: cells[2] || null,
      games: intval(cells[3]),
      pa: intval(cells[4]),
      ab: intval(cells[5]),
      r: intval(cells[6]),
      h: intval(cells[7]),
      double: intval(cells[8]),
      triple: intval(cells[9]),
      hr: intval(cells[10]),
      tb: intval(cells[11]),
      rbi: intval(cells[12]),
      sb: intval(cells[13]),
      bb: intval(cells[17]),
      k: intval(cells[20]),
      slg: cells[22] || null,
      obp: cells[23] || null,
      ops: (() => {
        const s = num(cells[22]), o = num(cells[23]);
        return (s != null && o != null) ? (s + o).toFixed(3).replace(/^0/, '') : null;
      })(),
    });
  });
  return out;
}

// 個人投手（ウエスタン）からカープ選手を抽出
async function fetchFarmPitchers() {
  const url = `https://npb.jp/bis/${YEAR}/stats/pit_2w.html`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  // 列: 順位|投手|防御率|登板|勝利|敗北|セーブ|完投|完封勝|無四球|勝率|打者|
  //     投球回|安打|本塁打|四球|故意四|死球|三振|暴投|ボーク|失点|自責点
  const out = [];
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('th, td').map((_, c) => $(c).text().trim()).get();
    if (cells.length < 23) return;
    const p = parsePlayerCell(cells[1]);
    if (p.team !== '広') return;
    out.push({
      name: p.name,
      era: cells[2] || null,
      games: intval(cells[3]),
      wins: intval(cells[4]),
      losses: intval(cells[5]),
      saves: intval(cells[6]),
      ip: cells[12] || null,
      hitsAllowed: intval(cells[13]),
      hrAllowed: intval(cells[14]),
      walks: intval(cells[15]),
      strikeouts: intval(cells[18]),
      runs: intval(cells[21]),
      earnedRuns: intval(cells[22]),
    });
  });
  return out;
}

async function main() {
  console.error('[fetch_npb_farm] Fetching Carp farm stats (Western League)...');
  let batters = [], pitchers = [];
  try {
    batters = await fetchFarmBatters();
    console.error(`[fetch_npb_farm] batters: ${batters.length}人 (${batters.map(b => b.name).join(', ')})`);
  } catch (e) {
    console.error(`[fetch_npb_farm] batters fetch failed: ${e.message}`);
  }
  try {
    pitchers = await fetchFarmPitchers();
    console.error(`[fetch_npb_farm] pitchers: ${pitchers.length}人 (${pitchers.map(p => p.name).join(', ')})`);
  } catch (e) {
    console.error(`[fetch_npb_farm] pitchers fetch failed: ${e.message}`);
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    year: YEAR,
    league: 'western',
    note: 'カープ2軍（ウエスタン）の個人成績。規定打席/規定投球回以上の選手のみNPB公式に掲載される。',
    sourceUrls: {
      batters: `https://npb.jp/bis/${YEAR}/stats/bat_2w.html`,
      pitchers: `https://npb.jp/bis/${YEAR}/stats/pit_2w.html`,
    },
    batters,
    pitchers,
  };

  if (dry) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  await fs.mkdir(GAMES_DIR, { recursive: true });
  const outPath = path.join(GAMES_DIR, 'npb_farm_carp.json');
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[fetch_npb_farm] Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(`[fetch_npb_farm] ERROR: ${e.message}`);
  process.exit(1);
});
