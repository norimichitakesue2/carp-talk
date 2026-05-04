// nf3.sakura.ne.jp (プロ野球ヌルデータ置き場f3) からの統計スクレイパー
// 相手先発投手の通算/今季成績、対カープ成績などを取得する
//
// 使い方 (ライブラリとして):
//   import { fetchOpponentPitcherData } from './fetch_nf3.mjs';
//   const data = await fetchOpponentPitcherData('阪神', '村上頌樹');
//
// 使い方 (CLI、デバッグ用):
//   node scripts/fetch_nf3.mjs 阪神 村上頌樹
//
// nf3 への配慮:
// - リクエスト間 1.5 秒以上スリープ
// - User-Agent でファンサイト名乗り
// - 1試合あたり最大 3 fetch (背番号探索 + 投手詳細 + vs打者) で抑制
// - 失敗しても上位ロジックを止めない (catchして null 返却)

import * as cheerio from 'cheerio';

const NF3_BASE = 'https://nf3.sakura.ne.jp';
const UA = 'carp-talk-bot/0.1 (+https://carp-talk.vercel.app; fan-site, infrequent)';
const SLEEP_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// nf3 のチームコード対応表 (URL 上の {league}/{code} 部分)
// チーム名は NPB box / Yahoo の表記ゆれに対応するため、含まれていればマッチさせる
const NF3_TEAMS = [
  { keys: ['広島東洋カープ', 'カープ', '広島'],         league: 'Central',  code: 'C'  },
  { keys: ['阪神タイガース', 'タイガース', '阪神'],     league: 'Central',  code: 'T'  },
  { keys: ['横浜DeNAベイスターズ', 'ベイスターズ', 'DeNA', 'ＤｅＮＡ', '横浜'], league: 'Central', code: 'DB' },
  { keys: ['読売ジャイアンツ', 'ジャイアンツ', '巨人'], league: 'Central',  code: 'G'  },
  { keys: ['中日ドラゴンズ', 'ドラゴンズ', '中日'],     league: 'Central',  code: 'D'  },
  { keys: ['東京ヤクルトスワローズ', 'スワローズ', 'ヤクルト'], league: 'Central', code: 'S' },
  { keys: ['福岡ソフトバンクホークス', 'ホークス', 'ソフトバンク'], league: 'Pacific', code: 'H' },
  { keys: ['北海道日本ハムファイターズ', 'ファイターズ', '日本ハム', '日ハム'], league: 'Pacific', code: 'F' },
  { keys: ['オリックス・バファローズ', 'バファローズ', 'オリックス'], league: 'Pacific', code: 'B' },
  { keys: ['東北楽天ゴールデンイーグルス', 'イーグルス', '楽天'], league: 'Pacific', code: 'E' },
  { keys: ['埼玉西武ライオンズ', 'ライオンズ', '西武'], league: 'Pacific',  code: 'L'  },
  { keys: ['千葉ロッテマリーンズ', 'マリーンズ', 'ロッテ'], league: 'Pacific', code: 'M' },
];

export function teamLookup(name) {
  const k = (name || '').replace(/\s+/g, '');
  if (!k) return null;
  for (const t of NF3_TEAMS) {
    for (const key of t.keys) {
      if (k.includes(key)) return { league: t.league, code: t.code };
    }
  }
  return null;
}

async function fetchUA(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

// 名前のゆらぎを許容するための正規化
//   - 全角空白/半角空白を除去
//   - 漢字一致または名字一致でマッチさせる
function normalizeName(s) {
  return (s || '').replace(/[\s　]+/g, '');
}
function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // 床田 / 床田寛樹 のような部分一致
  if (na.length >= 2 && nb.includes(na)) return true;
  if (nb.length >= 2 && na.includes(nb)) return true;
  return false;
}

// チームの投手一覧から (背番号, 漢字フルネーム) を引く
// fetch 1 回で全投手分が取れるので、複数投手調べたい場合は外側でキャッシュすると吉
export async function findPitcherNumber({ league, code }, pitcherName) {
  const url = `${NF3_BASE}/${league}/${code}/t/pc_all_data_vsT.htm`;
  const html = await fetchUA(url);
  const $ = cheerio.load(html);

  let found = null;
  $('tr td a[href*="_stat.htm"]').each((_, a) => {
    if (found) return;
    const $a = $(a);
    const txt = $a.text().trim();
    if (!namesMatch(txt, pitcherName)) return;
    const href = $a.attr('href') || '';
    const m = href.match(/\/p\/(\d+)_stat\.htm/);
    if (m) found = { number: m[1], fullName: txt };
  });
  return found;
}

// 投手の総合成績ページ（_stat.htm）をパース
export async function fetchPitcherStats({ league, code }, num) {
  const url = `${NF3_BASE}/${league}/${code}/p/${num}_stat.htm`;
  const html = await fetchUA(url);
  const $ = cheerio.load(html);

  // ヘッダーから氏名・利き腕・最終登板を抽出
  // ページ全体から探した方が確実（#header_p の構造が球団・年度で微妙に違うため）
  const fullPageText = $('body').text().replace(/[\s　]+/g, ' ').trim();
  // "#19 床田寛樹" や "#41 村上頌樹" などのパターン
  const nameMatch = fullPageText.match(/#\s*(\d+)\s+([^\s#]+?)\s*(?:投手|投打|右投|左投)/);
  const handMatch = fullPageText.match(/(右|左)投(右|左)打/);

  // 「最終登板」のテーブル (左側 .p_info)
  let lastAppearance = '';
  // ヘッダー次の値セルの形式 "M/D" を探す
  const lastAppMatch = fullPageText.match(/最終登板\s*連投状況\s*([\d\/]+)/);
  if (lastAppMatch) lastAppearance = lastAppMatch[1];

  // 通算成績テーブル (Base_P)
  // 行構造: header(th) → data(td) → header(th) → data(td)
  const career = {};
  $('table.Base_P').each((_, t) => {
    const cap = $(t).find('caption').text().trim();
    if (cap !== '通算成績') return;
    const rows = $(t).find('tr');
    // rows[0]=th行, rows[1]=td行, rows[2]=th行, rows[3]=td行
    const collect = (hRow, dRow) => {
      const hs = $(hRow).find('th').map((_, c) => $(c).text().trim()).get();
      const ds = $(dRow).find('td').map((_, c) => $(c).text().trim()).get();
      hs.forEach((h, i) => { if (h) career[h] = ds[i] || ''; });
    };
    if (rows.length >= 2) collect(rows[0], rows[1]);
    if (rows.length >= 4) collect(rows[2], rows[3]);
  });

  return {
    number: nameMatch ? nameMatch[1] : String(num),
    name: nameMatch ? nameMatch[2] : '',
    hand: handMatch ? `${handMatch[1]}投${handMatch[2]}打` : '',
    lastAppearance,
    era: career['防御率'] || null,
    games: parseIntOrNull(career['試合']),
    starts: parseIntOrNull(career['先発']),
    relief: parseIntOrNull(career['救援']),
    wins: parseIntOrNull(career['勝利']),
    losses: parseIntOrNull(career['敗戦']),
    holds: parseIntOrNull(career['HLD']),
    saves: parseIntOrNull(career['Ｓ'] ?? career['S']),
    completeGames: parseIntOrNull(career['完投']),
    shutouts: parseIntOrNull(career['完封']),
    ip: career['回数'] || null,           // "33.2" など分数表記なので文字列で保持
    pitches: parseIntOrNull(career['投球数']),
    pitchesPerInning: career['P/IP'] || null,
    hitsAllowed: parseIntOrNull(career['被安']),
    hrAllowed: parseIntOrNull(career['被本']),
    strikeouts: parseIntOrNull(career['三振']),
    walks: parseIntOrNull(career['四球']),
    hbp: parseIntOrNull(career['死球']),
    runs: parseIntOrNull(career['失点']),
    earnedRuns: parseIntOrNull(career['自責']),
    whip: career['WHIP'] || null,
    qsRate: career['QS率'] || null,
    winPct: career['勝率'] || null,
  };
}

// 投手の対打者ページ (_stat_vsB.htm) からカープ打者の対戦成績を抜く
// 構造: <tr> th colspan=14 内に <a name="vsT"> のような anchor があり、
// その下に <tr class="Index">列見出し → <tr class="Index2">通算 → <tr>個別打者
export async function fetchPitcherVsCarp({ league, code }, num) {
  const url = `${NF3_BASE}/${league}/${code}/p/${num}_stat_vsB.htm`;
  const html = await fetchUA(url);
  const $ = cheerio.load(html);

  let inCarpSection = false;
  const result = [];

  // 走査は table 内の tr を順番に
  $('table.Base tr').each((_, r) => {
    const $r = $(r);

    // セクション区切り (th colspan=14 にチームヘッダー)
    const $sectTh = $r.find('th[colspan="14"]');
    if ($sectTh.length) {
      const anchorName = $sectTh.find('a[name]').attr('name') || '';
      if (anchorName === 'vsC') inCarpSection = true;
      else if (anchorName.startsWith('vs')) inCarpSection = false;
      return;
    }

    if (!inCarpSection) return;
    if ($r.hasClass('Index') || $r.hasClass('Index2')) return; // ヘッダー・通算は除外

    const cells = $r.find('td').map((_, c) => $(c).text().trim()).get();
    if (cells.length < 14) return;

    const name = $r.find('a').first().text().trim();
    if (!name) return;

    result.push({
      name,
      bats: cells[1],
      avg: cells[2],
      pa: parseIntOrNull(cells[3]),
      ab: parseIntOrNull(cells[4]),
      h: parseIntOrNull(cells[5]),
      d: parseIntOrNull(cells[6]),
      t: parseIntOrNull(cells[7]),
      hr: parseIntOrNull(cells[8]),
      k: parseIntOrNull(cells[9]),
      bb: parseIntOrNull(cells[10]),
      hbp: parseIntOrNull(cells[11]),
      sh: parseIntOrNull(cells[12]),
      sf: parseIntOrNull(cells[13]),
    });
  });

  return result;
}

function parseIntOrNull(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// === 統合エントリ: 試合用に呼ぶトップレベル関数 ===
//
// opts.includeVsBatters=false にすると Phase 2 のみ (3 fetch → 2 fetch に削減)
// includeVsBatters=true で Phase 3 用の vsB データも併せて取得
export async function fetchOpponentPitcherData(opponentTeamName, pitcherName, opts = {}) {
  const includeVsBatters = !!opts.includeVsBatters;

  const team = teamLookup(opponentTeamName);
  if (!team) {
    console.error(`[nf3] Unknown team: "${opponentTeamName}"`);
    return null;
  }

  let foundPitcher;
  try {
    foundPitcher = await findPitcherNumber(team, pitcherName);
  } catch (e) {
    console.error(`[nf3] findPitcherNumber failed: ${e.message}`);
    return null;
  }
  if (!foundPitcher) {
    console.error(`[nf3] Pitcher not found in nf3: "${pitcherName}" (${opponentTeamName})`);
    return null;
  }

  await sleep(SLEEP_MS);
  let stats;
  try {
    stats = await fetchPitcherStats(team, foundPitcher.number);
  } catch (e) {
    console.error(`[nf3] fetchPitcherStats failed: ${e.message}`);
    return null;
  }

  let vsCarp = null;
  if (includeVsBatters) {
    await sleep(SLEEP_MS);
    try {
      vsCarp = await fetchPitcherVsCarp(team, foundPitcher.number);
    } catch (e) {
      console.error(`[nf3] fetchPitcherVsCarp failed: ${e.message}`);
      // vsCarp 失敗は致命傷ではないので継続
    }
  }

  return {
    team: opponentTeamName,
    teamCode: team.code,
    league: team.league,
    number: foundPitcher.number,
    name: foundPitcher.fullName,
    queriedName: pitcherName,
    stats,
    vsCarp,
    sourceUrls: {
      stats: `${NF3_BASE}/${team.league}/${team.code}/p/${foundPitcher.number}_stat.htm`,
      vsB:   includeVsBatters ? `${NF3_BASE}/${team.league}/${team.code}/p/${foundPitcher.number}_stat_vsB.htm` : null,
    },
  };
}

// === CLI ===
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node scripts/fetch_nf3.mjs <チーム名> <投手名> [--vsB]');
    console.error('Example: node scripts/fetch_nf3.mjs 阪神 村上頌樹 --vsB');
    process.exit(1);
  }
  const team = args[0];
  const name = args[1];
  const includeVsBatters = args.includes('--vsB');
  const data = await fetchOpponentPitcherData(team, name, { includeVsBatters });
  console.log(JSON.stringify(data, null, 2));
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
               import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') || '');
if (isMain) main().catch((e) => { console.error('[nf3] ERROR:', e); process.exit(1); });
