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
  // 苗字1文字（「東」「林」「森」など）対応:
  //   検索語が短くてもリスト名の「先頭一致」ならOK（"東" → "東克樹"）
  //   苗字は通常先頭にあるので startsWith に絞って誤マッチを防ぐ
  if (nb.length === 1 && na.startsWith(nb)) return true;
  if (na.length === 1 && nb.startsWith(na)) return true;
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

  // Phase 5: 投手の対左/対右打者 成績テーブル (左右別成績)
  const splits = { vsRightBatter: null, vsLeftBatter: null };
  $('table.Base_P').each((_, t) => {
    const cap = $(t).find('caption').text().trim();
    if (cap !== '左右別成績') return;
    const rows = $(t).find('tr');
    let headers = [];
    let dataRowsStart = -1;
    rows.each((i, r) => {
      const ths = $(rows[i]).find('th').map((_, c) => $(c).text().trim()).get();
      if (ths.length >= 5 && ths.includes('打率')) {
        headers = ths;
        dataRowsStart = i + 1;
      }
    });
    if (headers.length === 0) return;
    for (let i = dataRowsStart; i < rows.length; i++) {
      const $r = $(rows[i]);
      const firstTh = $r.find('th').first().text().trim();
      const cells = $r.find('td').map((_, c) => $(c).text().trim()).get();
      if (cells.length === 0) continue;
      const obj = {};
      for (let j = 1; j < headers.length; j++) obj[headers[j]] = cells[j - 1] || '';
      const mapped = {
        avg: obj['打率'] || null,
        pa: parseIntOrNull(obj['打席']),
        ab: parseIntOrNull(obj['打数']),
        h: parseIntOrNull(obj['安打']),
        hr: parseIntOrNull(obj['本塁'] ?? obj['本塁打']),
        k: parseIntOrNull(obj['三振']),
        bb: parseIntOrNull(obj['四球']),
      };
      if (firstTh === '対右打者') splits.vsRightBatter = mapped;
      else if (firstTh === '対左打者') splits.vsLeftBatter = mapped;
    }
  });

  // Yahoo Sportsnavi の player ID をヘッダーリンクから抽出
  // <a href="https://baseball.yahoo.co.jp/npb/player/1600123/top">
  let yahooPlayerId = null;
  $('a[href*="baseball.yahoo.co.jp/npb/player/"]').each((_, a) => {
    if (yahooPlayerId) return;
    const href = $(a).attr('href') || '';
    const m = href.match(/\/npb\/player\/(\d+)/);
    if (m) yahooPlayerId = m[1];
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
    vsRightBatter: splits.vsRightBatter,
    vsLeftBatter: splits.vsLeftBatter,
    yahooPlayerId,
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

// === カープ打者の名簿 + 個別成績取得 ===
// 1日1回キャッシュする想定。試合ごとには json を読むだけで済む

// nf3 の打撃成績PHPページから全カープ打者の (背番号, フルネーム) を取得
// 投手の打撃成績ページもこのリストに混ざるが、投手は対右左成績がほぼ意味ないのでフィルタ前提
export async function fetchCarpBatterList() {
  const url = `${NF3_BASE}/php/stat_disp/stat_disp.php?y=0&leg=0&tm=C&fp=0&dn=1&dk=0`;
  const html = await fetchUA(url);
  const $ = cheerio.load(html);

  const out = [];
  const seen = new Set();
  $('a[href*="/Central/C/f/"][href$="_stat.htm"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    const m = href.match(/\/f\/(\d+)_stat\.htm/);
    if (!m) return;
    const num = m[1];
    const name = $a.text().trim();
    if (!name || seen.has(num)) return;
    seen.add(num);
    out.push({ number: num, name });
  });
  return out;
}

// 個別打者ページから 通算 + 対右/対左 成績を抜く
export async function fetchBatterStats(num) {
  const url = `${NF3_BASE}/Central/C/f/${num}_stat.htm`;
  const html = await fetchUA(url);
  const $ = cheerio.load(html);

  // ヘッダーから氏名・利き腕
  const fullPageText = $('body').text().replace(/[\s　]+/g, ' ').trim();
  const nameMatch = fullPageText.match(/#\s*(\d+)\s+([^\s#]+?)\s*(?:野手|投手|内野手|外野手|捕手|左投|右投)/);
  const handMatch = fullPageText.match(/(右|左|両)投(右|左|両)打/);

  // 通算成績テーブル
  // ヘッダ: 打率/打席/打数/得点/安打/2塁/3塁/本塁/打点/盗塁/盗死/犠打/犠飛/四球/敬遠/死球/三振/併殺/出塁/長打/OPS など
  let career = {};
  $('table.Base_P').each((_, t) => {
    const cap = $(t).find('caption').text().trim();
    if (cap !== '通算成績') return;
    const rows = $(t).find('tr');
    const collect = (hRow, dRow) => {
      const hs = $(hRow).find('th').map((_, c) => $(c).text().trim()).get();
      const ds = $(dRow).find('td').map((_, c) => $(c).text().trim()).get();
      hs.forEach((h, i) => { if (h) career[h] = ds[i] || ''; });
    };
    if (rows.length >= 2) collect(rows[0], rows[1]);
    if (rows.length >= 4) collect(rows[2], rows[3]);
  });

  // 対左右別成績テーブル (対右投手 / 対左投手)
  // 列: 打率/打席/打数/安打/2塁/3塁/本塁/三振/四球/死球/犠打/犠飛
  const splits = { vsRight: null, vsLeft: null };
  $('table.Base_P').each((_, t) => {
    const cap = $(t).find('caption').text().trim();
    if (cap !== '対左右別成績') return;
    const rows = $(t).find('tr');
    // header 行を探す
    let headers = [];
    let dataRowsStart = -1;
    rows.each((i, r) => {
      const $r = $(rows[i]);
      const ths = $r.find('th').map((_, c) => $(c).text().trim()).get();
      if (ths.length >= 5 && ths.includes('打率')) {
        headers = ths;
        dataRowsStart = i + 1;
      }
    });
    if (headers.length === 0) return;
    for (let i = dataRowsStart; i < rows.length; i++) {
      const $r = $(rows[i]);
      const firstTh = $r.find('th').first().text().trim();
      const cells = $r.find('td').map((_, c) => $(c).text().trim()).get();
      if (cells.length === 0) continue;
      // headers[0] は「対右投手」「対左投手」のラベル列なので、cells は headers.length - 1 個
      const obj = {};
      for (let j = 1; j < headers.length; j++) {
        obj[headers[j]] = cells[j - 1] || '';
      }
      if (firstTh === '対右投手') splits.vsRight = obj;
      else if (firstTh === '対左投手') splits.vsLeft = obj;
    }
  });

  return {
    number: String(num),
    name: nameMatch ? nameMatch[2] : '',
    hand: handMatch ? `${handMatch[1]}投${handMatch[2]}打` : '',
    career: {
      avg: career['打率'] || null,
      pa: parseIntOrNull(career['打席']),
      ab: parseIntOrNull(career['打数']),
      r: parseIntOrNull(career['得点']),
      h: parseIntOrNull(career['安打']),
      d: parseIntOrNull(career['2塁打'] ?? career['二塁']),
      t: parseIntOrNull(career['3塁打'] ?? career['三塁']),
      hr: parseIntOrNull(career['本塁打'] ?? career['本塁']),
      rbi: parseIntOrNull(career['打点']),
      sb: parseIntOrNull(career['盗塁']),
      bb: parseIntOrNull(career['四球']),
      k: parseIntOrNull(career['三振']),
      obp: career['出塁'] || career['出塁率'] || null,
      slg: career['長打'] || career['長打率'] || null,
      ops: career['OPS'] || null,
    },
    vsRight: splits.vsRight ? mapBatterSplit(splits.vsRight) : null,
    vsLeft:  splits.vsLeft  ? mapBatterSplit(splits.vsLeft)  : null,
  };
}

function mapBatterSplit(o) {
  return {
    avg: o['打率'] || null,
    pa: parseIntOrNull(o['打席']),
    ab: parseIntOrNull(o['打数']),
    h: parseIntOrNull(o['安打']),
    hr: parseIntOrNull(o['本塁'] ?? o['本塁打']),
    k: parseIntOrNull(o['三振']),
    bb: parseIntOrNull(o['四球']),
  };
}

// === Phase 6: Yahoo Sportsnavi から投手の球種データを取得 ===
//
// Yahoo の player top ページには HTML テーブルとして
// 球種 / 球速(最高/平均) / 投球割合(全体/対左/対右) / 奪三振率 / 空振り率 / 被打率
// が静的に埋め込まれている (JS不要)。
//
// テーブル構造:
//   <table class="bb-pitchingRateTable">
//     <thead> 球種, 球速最高/平均, 投球割合全体/対左/対右, 奪三振率, 空振り率, 被打率 </thead>
//     <tbody>
//       <tr><th>ストレート</th><td>150</td><td>143.3</td>...</tr>
//
// nf3 fetch の延長で1回呼ぶだけ (試合あたり +1 fetch、Yahoo へ)。
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
async function fetchYahooHtml(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': YAHOO_UA, 'Accept-Language': 'ja-JP,ja;q=0.9' },
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}: ${url}`);
  return await r.text();
}

export async function fetchYahooPitcherProfile(yahooPlayerId) {
  if (!yahooPlayerId) return null;
  const url = `https://baseball.yahoo.co.jp/npb/player/${yahooPlayerId}/top`;
  const html = await fetchYahooHtml(url);
  const $ = cheerio.load(html);

  // 球種テーブル: class に "bb-pitchingRateTable" を含む table
  const tbl = $('table.bb-pitchingRateTable').first();
  if (!tbl.length) return { yahooPlayerId, pitchTypes: [] };

  const pitchTypes = [];
  tbl.find('tbody tr').each((_, r) => {
    const $r = $(r);
    const name = $r.find('th').first().text().trim();
    if (!name) return;
    const cells = $r.find('td').map((_, c) => $(c).text().trim().replace(/\s+/g, ' ')).get();
    // 列順 (確認済み): 最高(km/h), 平均, 投球割合全体%, 対左%, 対右%, 奪三振率(回数), 空振り率, 被打率(被本塁打)
    if (cells.length < 8) return;
    pitchTypes.push({
      name,
      maxSpeed: cells[0],          // "150"
      avgSpeed: cells[1],          // "143.3"
      ratioOverall: cells[2],      // "33.7%"
      ratioVsLeft: cells[3],       // "36.8%"
      ratioVsRight: cells[4],      // "32.1%"
      kRate: cells[5],             // "17.4% (4)"
      whiffRate: cells[6],         // "4.2%"
      avgAgainst: cells[7],        // ".302 (2)"
    });
  });

  return { yahooPlayerId, sourceUrl: url, pitchTypes };
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

  // Phase 6: Yahoo Sportsnavi から球種・球速データ取得
  // nf3 投手ページ内のリンクから取得した yahooPlayerId を使う
  let yahoo = null;
  if (stats?.yahooPlayerId && opts.includeYahooPitchTypes !== false) {
    await sleep(SLEEP_MS);
    try {
      yahoo = await fetchYahooPitcherProfile(stats.yahooPlayerId);
      console.error(`[nf3] Yahoo球種取得: ${yahoo?.pitchTypes?.length ?? 0} 球種`);
    } catch (e) {
      console.error(`[nf3] fetchYahooPitcherProfile failed: ${e.message}`);
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
    yahoo,
    sourceUrls: {
      stats: `${NF3_BASE}/${team.league}/${team.code}/p/${foundPitcher.number}_stat.htm`,
      vsB:   includeVsBatters ? `${NF3_BASE}/${team.league}/${team.code}/p/${foundPitcher.number}_stat_vsB.htm` : null,
      yahoo: stats?.yahooPlayerId ? `https://baseball.yahoo.co.jp/npb/player/${stats.yahooPlayerId}/top` : null,
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

// `node scripts/fetch_nf3.mjs ...` で実行された時のみ main() を走らせる。
// `node -e "import('./scripts/fetch_nf3.mjs')..."` のような import 経由では走らせない。
const argv1 = process.argv[1] || '';
const isMain = argv1.endsWith('fetch_nf3.mjs');
if (isMain) main().catch((e) => { console.error('[nf3] ERROR:', e); process.exit(1); });
