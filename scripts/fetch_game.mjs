// NPB公式からカープの試合データを取得してJSONを返すスクレイパー
// 使い方:
//   node scripts/fetch_game.mjs YYYY-MM-DD
// 出力: カープが試合してる場合はJSON、試合がない場合はexit 2
//
// 利用規約への配慮:
// - 事実データ（スコア・選手名・イニング）のみを取得
// - 解説テキスト・記事はコピーしない
// - 自サイトを名乗るUser-Agent
// - リクエスト間は1.5秒以上スリープ

import * as cheerio from 'cheerio';
import { TEAM_BY_CODE, isCarpGame, parseGameSegment, SHORT_NAMES } from './team_codes.mjs';

const UA = 'carp-talk-bot/0.1 (+https://carp-talk.vercel.app; fan-site data sync)';
const SLEEP_MS = 1500;

async function fetchWithUA(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDate(dateStr) {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date: ${dateStr}`);
  return { year: m[1], month: m[2], day: m[3] };
}

// その月のスケジュールページから、指定日付のカープの試合URLセグメントを検索
async function findCarpGameSegment({ year, month, day }) {
  const scheduleUrl = `https://npb.jp/games/${year}/schedule_${month}_detail.html`;
  const html = await fetchWithUA(scheduleUrl);
  const $ = cheerio.load(html);

  const links = new Set();
  $(`a[href*="/scores/${year}/${month}${day}/"]`).each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(new RegExp(`/scores/${year}/${month}${day}/([^/]+)/`));
    if (m) links.add(m[1]);
  });

  for (const seg of links) {
    if (isCarpGame(seg)) return seg;
  }
  return null;
}

// テキストから既知の短縮チーム名を抜き出す（重複表記対応）
// 例: "東京ヤクルトスワローズヤクルト" → "ヤクルト"
function extractShortTeamName(text) {
  const t = (text || '').replace(/\s+/g, '');
  for (const short of SHORT_NAMES) {
    if (t.endsWith(short)) return short;
  }
  // フォールバック：DeNA/楽天等は二回繰り返さないこともあるので、含むかでも判定
  for (const short of SHORT_NAMES) {
    if (t.includes(short)) return short;
  }
  return t;
}

// イニング数値の正規化
function normInning(v) {
  if (v === '' || v == null) return 0;
  if (v === '-' || v === 'X') return v;
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

function parseIntSafe(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? null : n;
}

async function fetchBoxFacts({ year, month, day, segment }) {
  const base = `https://npb.jp/scores/${year}/${month}${day}/${segment}`;
  const boxHtml = await fetchWithUA(`${base}/box.html`);
  const $ = cheerio.load(boxHtml);

  const bodyText = $('body').text();
  const statusInfo = parseStatus(bodyText);
  const status = statusInfo.status;
  const currentInning = statusInfo.currentInning;
  const venue = parseVenue($);
  const startEnd = parseStartEnd(bodyText);
  const lineScore = parseLineScore($);
  const awayBat = parseBatting($, $('table#tablefix_t_b'));
  const homeBat = parseBatting($, $('table#tablefix_b_b'));
  const awayPitch = parsePitching($, $('table#tablefix_t_p'));
  const homePitch = parsePitching($, $('table#tablefix_b_p'));
  const homeRuns = extractHomeRuns(awayBat).concat(extractHomeRuns(homeBat));

  const gameParts = parseGameSegment(segment);
  const carpIsHome = gameParts?.homeCode === 'c';
  const carpBat = carpIsHome ? homeBat : awayBat;
  const opBat = carpIsHome ? awayBat : homeBat;
  const carpPitch = carpIsHome ? homePitch : awayPitch;
  const opPitch = carpIsHome ? awayPitch : homePitch;

  // Roster 取得（試合前・試合中問わず存在する。試合後でもOK）
  await sleep(SLEEP_MS);
  let roster = { carp: [], opponent: [] };
  try {
    roster = await fetchRoster(`${base}/roster.html`);
  } catch (e) {
    console.error(`[fetch_game] roster fetch failed: ${e.message}`);
  }

  // playbyplay.html から一球速報を取得（試合中・試合終了後）
  let playByPlay = [];
  if (status === 'live' || status === 'final') {
    await sleep(SLEEP_MS);
    try {
      playByPlay = await fetchPlayByPlay(`${base}/playbyplay.html`);
    } catch (e) {
      console.error(`[fetch_game] playbyplay fetch failed: ${e.message}`);
    }
  }

  // 試合前/中 で NPB に先発投手が無ければ Yahoo!プロ野球から予告先発を取得
  let yahooStarters = { homeStarter: null, awayStarter: null };
  const carpPitchStarter = (carpIsHome ? homePitch : awayPitch)[0]?.name || null;
  const opPitchStarter = (carpIsHome ? awayPitch : homePitch)[0]?.name || null;
  if (!carpPitchStarter || !opPitchStarter) {
    await sleep(SLEEP_MS);
    try {
      yahooStarters = await fetchYahooStarters({ year, month, day });
    } catch (e) {
      console.error(`[fetch_game] Yahoo starters fetch failed: ${e.message}`);
    }
  }
  // NPB に投手情報がある場合は NPB を優先、無ければ Yahoo を採用
  const finalCarpStarter = carpPitchStarter || (carpIsHome ? yahooStarters.homeStarter : yahooStarters.awayStarter);
  const finalOpStarter   = opPitchStarter   || (carpIsHome ? yahooStarters.awayStarter : yahooStarters.homeStarter);

  return {
    segment,
    status,
    currentInning,
    venue,
    startTime: startEnd.start,
    endTime: startEnd.end,
    gameParts,
    carpIsHome,
    lineScore,
    pitchers: {
      carpStarter: finalCarpStarter,
      opStarter: finalOpStarter,
      winningPitcher: [...awayPitch, ...homePitch].find((p) => p.result === 'win')?.name || null,
      losingPitcher: [...awayPitch, ...homePitch].find((p) => p.result === 'loss')?.name || null,
      savePitcher: [...awayPitch, ...homePitch].find((p) => p.result === 'save')?.name || null,
      carpAll: carpPitch.map((p) => ({ name: p.name, result: p.result, ipText: p.ipText })),
      opAll: opPitch.map((p) => ({ name: p.name, result: p.result, ipText: p.ipText })),
      carpStarterSource: carpPitchStarter ? 'npb' : (yahooStarters.homeStarter || yahooStarters.awayStarter ? 'yahoo' : 'unknown'),
    },
    homeRuns,
    carpLineup: carpBat.map((b) => ({ name: b.name, pos: b.pos, line: b.lineupNum })),
    opponentLineup: opBat.map((b) => ({ name: b.name, pos: b.pos, line: b.lineupNum })),
    carpRoster: roster.carp,
    opponentRoster: roster.opponent,
    playByPlay,
  };
}

// playbyplay.html から一球速報を取得
// 構造: <h5>1回表（チーム攻撃）</h5> 直後に複数の <table>
//   各 <table> は1打席で、<tr> が [アウト | 塁上 | 打者 | カウント | 結果]
//   または投手情報 <td colspan="5">（先発投手）NAME</td> や （投手交代）OLD → NEW
async function fetchPlayByPlay(url) {
  const html = await fetchWithUA(url);
  const $ = cheerio.load(html);
  const plays = [];

  // h5#com1-1 みたいなID付きの見出しがイニング区切り
  $('h5[id^="com"]').each((_, h5) => {
    const $h5 = $(h5);
    const m = $h5.text().match(/^([1-9]|1[0-2])回(表|裏)/);
    if (!m) return;
    const inning = `${m[1]}回${m[2]}`;
    const half = m[2] === '表' ? 'top' : 'bottom';

    // 次のh5までのsibling tableを順に処理
    let $cur = $h5.next();
    while ($cur.length && !$cur.is('h5')) {
      if ($cur.is('table')) {
        $cur.find('tr').each((_, r) => {
          const $tds = $(r).find('td');
          if (!$tds.length) return;
          const cells = $tds.map((_, c) => ({
            text: $(c).text().trim().replace(/\s+/g, ''),
            colspan: parseInt($(c).attr('colspan') || '0', 10),
          })).get();

          // 投手情報行
          if (cells[0].colspan >= 4 || /^（(先発投手|投手|投手交代)）/.test(cells[0].text)) {
            plays.push({ inning, half, type: 'pitcher_info', text: cells[0].text });
            return;
          }
          // 打席結果行 (5列: アウト/塁上/打者/カウント/結果)
          if (cells.length >= 5) {
            plays.push({
              inning, half,
              type: 'play',
              outs: cells[0].text,
              runners: cells[1].text || '',
              batter: cells[2].text,
              count: cells[3].text,
              result: cells[4].text,
            });
          }
        });
      }
      $cur = $cur.next();
    }
  });

  return plays;
}

// ベンチ入り選手 (roster.html) 取得・パース
// NPBの構造: <div class="roster_section"><h5>チーム名</h5><table>...</table></div>
// テーブル内: <th colspan="3">投手/捕手/内野手/外野手</th> がセクションヘッダー、
// 各選手は <td class="num">背番号</td><td><a>名前</a></td><td class="w4">右投右打</td>
async function fetchRoster(url) {
  const html = await fetchWithUA(url);
  const $ = cheerio.load(html);
  const result = { carp: [], opponent: [] };

  $('div.roster_section').each((_, sec) => {
    const $sec = $(sec);
    const heading = $sec.find('h5, h4, h3, h2').first().text().trim();
    const $tbl = $sec.find('table').first();
    if (!$tbl.length) return;

    const isCarp = /広島東洋カープ|広島カープ/.test(heading);
    const players = parseRosterTable($, $tbl);
    if (players.length === 0) return;

    if (isCarp && result.carp.length === 0) result.carp = players;
    else if (!isCarp && result.opponent.length === 0) result.opponent = players;
  });

  return result;
}

// Yahoo!プロ野球の日次スケジュールから予告先発を取得
// URL: https://baseball.yahoo.co.jp/npb/schedule/?selectDate=YYYYMMDD
// スケジュールページの試合リンクテキストに「(予)大竹 (予)栗林」のように表示
async function fetchYahooStarters({ year, month, day }) {
  const url = `https://baseball.yahoo.co.jp/npb/schedule/?selectDate=${year}${month}${day}`;
  const html = await fetchWithUA(url);
  const $ = cheerio.load(html);

  let result = { homeStarter: null, awayStarter: null, gameId: null };

  // /npb/game/{id}/index|top の link を全部見て、テキストにカープ表記が含まれるものを採用
  $('a[href*="/npb/game/"]').each((_, el) => {
    if (result.homeStarter && result.awayStarter) return;
    const href = $(el).attr('href') || '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!/広島|カープ/.test(text)) return;
    const idMatch = href.match(/\/npb\/game\/(\d+)/);
    if (idMatch) result.gameId = idMatch[1];
    // フォーマット: "...見どころ (予)NAME1 (予)NAME2"
    // Yahoo の link テキストでは home → away の順で投手が並ぶ
    const m = text.match(/\(予\)\s*([^\s\(\)]+)\s*\(予\)\s*([^\s\(\)]+)/);
    if (m) {
      result.homeStarter = m[1];
      result.awayStarter = m[2];
    }
  });

  return result;
}

function parseRosterTable($, $tbl) {
  const players = [];
  let currentPos = '投'; // 冒頭は投手（NPB rosterの慣例）
  // 既知の捕手リストを使って 投/捕 を区別する補助
  const KNOWN_CATCHERS = new Set([
    '坂倉', '石原', '持丸', '會澤',
    // 阪神
    '梅野', '坂本', '伏見', '榮枝',
    // 巨人
    '大城', '小林', '岸田',
    // ヤクルト
    '中村', '内山', '松本',
    // 中日
    '木下', '加藤', '石橋',
    // DeNA
    '戸柱', '松尾', '山本',
  ]);

  $tbl.find('tr').each((_, row) => {
    // 行内のセクションラベル検知
    $(row).find('td, th').each((_, c) => {
      const t = $(c).text().trim();
      if (/^投手$/.test(t)) currentPos = '投';
      else if (/^捕手$/.test(t)) currentPos = '捕';
      else if (/^内野手$/.test(t)) currentPos = '内';
      else if (/^外野手$/.test(t)) currentPos = '外';
    });

    $(row).find('a[href*="/bis/players/"]').each((_, a) => {
      const name = $(a).text().trim().replace(/\s+/g, '');
      if (!name) return;
      let pos = currentPos;
      // 投手/捕手のセクションラベルが無いNPBレイアウト対応：内野手より前で投と判定された選手のうち、既知捕手なら捕に上書き
      if (pos === '投' && KNOWN_CATCHERS.has(name)) pos = '捕';
      // 同名のリンクが複数（投/打のリンクなど）あるケースは1人として扱う
      if (!players.find((p) => p.name === name)) {
        players.push({ name, pos });
      }
    });
  });

  return players;
}

function parseStatus(text) {
  // 中止系は最優先で判定（NPB は 試合終了 タグを残したまま 試合中止 を併記する場合があるため）
  if (/【試合中止】|【中止】|【ノーゲーム】|【コールドゲーム】/.test(text)) {
    return { status: 'cancelled', currentInning: null };
  }
  if (/【試合終了】/.test(text)) return { status: 'final', currentInning: null };
  // 「試合中」は「【試合中 1回表】」「【試合中断】」のような形式もある
  // ただし「【試合中止】」は上で先に弾いている
  const liveMatch = text.match(/【試合中\s*([^】止]*)】/);
  if (liveMatch) {
    const inning = liveMatch[1].trim();
    return { status: 'live', currentInning: inning || null };
  }
  if (/【試合前】|【試合開始前】/.test(text)) return { status: 'scheduled', currentInning: null };
  return { status: 'unknown', currentInning: null };
}

function parseVenue($) {
  // venue 検出戦略:
  //   1. <span class="place"> を最優先（NPB box ページではこれが当該試合の会場）
  //   2. fallback: 既知の球場名と完全一致する span/div を探索
  // NPB は「横　浜」(全角空白入り) や「（東京ドーム）」(括弧囲み) のような表記揺れがある。
  // 全角/半角空白を全て除去してから比較し、複数の表記揺れに対応する。
  // 表記揺れマッピング: "横浜" → "横浜スタジアム" のように整形して返す。
  const VENUE_NORMALIZE = {
    '横浜': '横浜スタジアム', '横浜スタジアム': '横浜スタジアム', 'ハマスタ': '横浜スタジアム',
    'マツダスタジアム': 'マツダスタジアム', 'MAZDAZoom-Zoomスタジアム広島': 'マツダスタジアム',
    '神宮': '神宮球場', '神宮球場': '神宮球場', '明治神宮野球場': '神宮球場',
    '甲子園': '阪神甲子園球場', '甲子園球場': '阪神甲子園球場', '阪神甲子園球場': '阪神甲子園球場',
    '東京ドーム': '東京ドーム',
    'バンテリンドーム': 'バンテリンドームナゴヤ', 'バンテリンドームナゴヤ': 'バンテリンドームナゴヤ',
    'バンテリン': 'バンテリンドームナゴヤ',
    '京セラD大阪': '京セラドーム大阪', '京セラドーム大阪': '京セラドーム大阪',
    '京セラドーム': '京セラドーム大阪',
    'PayPayドーム': 'PayPayドーム', '福岡PayPayドーム': 'PayPayドーム',
    'エスコンF': 'エスコンフィールドHOKKAIDO', 'エスコンフィールドHOKKAIDO': 'エスコンフィールドHOKKAIDO',
    'エスコン': 'エスコンフィールドHOKKAIDO',
    'ZOZOマリン': 'ZOZOマリンスタジアム', 'ZOZOマリンスタジアム': 'ZOZOマリンスタジアム',
    'ベルーナドーム': 'ベルーナドーム', 'ベルーナ': 'ベルーナドーム',
    '楽天モバイルパーク': '楽天モバイルパーク宮城', '楽天モバイルパーク宮城': '楽天モバイルパーク宮城',
    '楽天モバイル': '楽天モバイルパーク宮城',
    'ほっと神戸': 'ほっともっとフィールド神戸',
    '札幌ドーム': '札幌ドーム',
    'サンマリン宮崎': 'サンマリンスタジアム宮崎',
    '長良川球場': '岐阜長良川球場',
    '富山': '富山アルペンスタジアム', 'アルペン': '富山アルペンスタジアム',
    'マスカットスタジアム': '倉敷マスカットスタジアム',
  };

  // 囲み文字（全角/半角括弧）と空白を剥がす
  const normalize = (s) => (s || '')
    .replace(/^[（(【［\s　]+/, '')
    .replace(/[）)】］\s　]+$/, '')
    .replace(/[\s　]+/g, '')   // 全角/半角空白を内部からも除去
    .trim();

  let found = '';
  // 戦略1: <span class="place"> を最優先
  $('span.place').each((_, el) => {
    if (found) return;
    const raw = $(el).text();
    const t = normalize(raw);
    if (t && VENUE_NORMALIZE[t]) found = VENUE_NORMALIZE[t];
    else if (t && t.length < 30) found = t;  // 未知会場でも一旦そのまま採用
  });
  if (found) return found;

  // 戦略2: fallback - 既知の球場名と完全一致する要素を探す
  $('div, span, p, td, th').each((_, el) => {
    if (found) return;
    const raw = $(el).text();
    if (!raw || raw.length > 30) return;
    const t = normalize(raw);
    if (VENUE_NORMALIZE[t]) found = VENUE_NORMALIZE[t];
  });
  return found;
}

function parseStartEnd(text) {
  const m = text.match(/◇開始\s*([\d:]+)\s*◇終了\s*([\d:]+)/);
  if (m) return { start: m[1], end: m[2] };
  const m2 = text.match(/◇開始\s*([\d:]+)/);
  if (m2) return { start: m2[1], end: '' };
  return { start: '', end: '' };
}

// スコアボード (id=tablefix_ls) を away/home の2行に分解
// 延長戦の場合、列構造が 1〜12 + 計/H/E となるため、ヘッダーから動的に列位置を解決する
function parseLineScore($) {
  const tbl = $('table#tablefix_ls');
  if (!tbl.length) return { away: null, home: null };
  const rows = tbl.find('tr');
  if (rows.length < 3) return { away: null, home: null };

  // ヘッダー行を読み、計/H/E の列位置を特定
  const headerCells = $(rows[0]).find('th, td').map((_, c) => $(c).text().trim()).get();
  const totalIdx = headerCells.findIndex((t) => t === '計' || t === 'R');
  const hitsIdx = headerCells.findIndex((t) => t === 'H' || t === '安');
  const errorsIdx = headerCells.findIndex((t) => t === 'E' || t === '失');
  // 1列目は team名、2列目以降が回数（最大 totalIdx-1 まで）
  const inningCount = totalIdx > 1 ? totalIdx - 1 : 9;

  const parseRow = ($r) => {
    const cells = $r.find('th, td').map((_, c) => $(c).text().trim()).get();
    if (cells.length < 4) return null;
    const teamRaw = cells[0].replace(/\s+/g, '');
    const team = extractShortTeamName(teamRaw);
    const innings = [];
    // 最低9回、延長があればそれ以上
    const limit = Math.max(9, inningCount);
    for (let i = 1; i <= limit; i++) innings.push(normInning(cells[i] || ''));
    const total = totalIdx > 0 ? (parseIntSafe(cells[totalIdx]) ?? 0)
                                : innings.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const hits = hitsIdx > 0 ? parseIntSafe(cells[hitsIdx]) : null;
    const errors = errorsIdx > 0 ? parseIntSafe(cells[errorsIdx]) : null;
    return { team, teamRaw, innings, total, hits, errors };
  };
  const away = parseRow($(rows[1]));
  const home = parseRow($(rows[2]));
  return { away, home };
}

// 打撃成績テーブル（tablefix_t_b / tablefix_b_b）を選手の配列に
// 列: |番|守備|選手|打数|得点|安打|打点|盗塁|1|2|3|4|5|6|7|8|9
function parseBatting($, $tbl) {
  if (!$tbl || !$tbl.length) return [];
  const rows = $tbl.find('tr').slice(1); // skip header
  const result = [];
  rows.each((_, r) => {
    const cells = $(r).find('th, td').map((_, c) => $(c).text().trim().replace(/\s+/g, ' ')).get();
    if (cells.length < 8) return;
    const lineupNum = parseIntSafe(cells[0]);
    const pos = (cells[1] || '').replace(/[（）()]/g, '').replace(/\s+/g, '');
    const name = (cells[2] || '').replace(/\s+/g, '');
    if (!name || /^選手$/.test(name)) return;
    // チーム計（合計行）など、選手以外の行を除外
    if (/チーム計|合計|計$/.test(name)) return;
    const innings = cells.slice(8, 17);
    result.push({ lineupNum, pos, name, innings });
  });
  return result;
}

// 投手成績テーブル（tablefix_t_p / tablefix_b_p）
// 列: |結果|投手|投球数|打者|投球回|安打|本塁打|四球|死球|三振|暴投|ボーク|失点|自責点
// 結果列に ○=勝 / ●=敗 / Ｓ or S=セーブ
function parsePitching($, $tbl) {
  if (!$tbl || !$tbl.length) return [];
  const rows = $tbl.find('tr').slice(1);
  const result = [];
  rows.each((_, r) => {
    const cells = $(r).find('th, td').map((_, c) => $(c).text().trim().replace(/\s+/g, ' ')).get();
    if (cells.length < 4) return;
    const flag = cells[0] || '';
    const name = (cells[1] || '').replace(/\s+/g, '');
    const ipText = cells[4] || cells[3] || '';  // 投球回
    if (!name || /^投手$/.test(name)) return;
    if (/チーム計|合計|計$/.test(name)) return;
    let resultMark = '';
    if (flag.includes('○') || /^[oO]$/.test(flag)) resultMark = 'win';
    else if (flag.includes('●')) resultMark = 'loss';
    else if (flag.includes('Ｓ') || flag === 'S') resultMark = 'save';
    else if (flag.includes('Ｈ') || flag === 'H') resultMark = 'hold';
    result.push({ name, result: resultMark, ipText });
  });
  return result;
}

// 打席結果に「本」を含むセルから本塁打情報を抽出
//   "右中本②" → { hitter: ..., inning: 5, type: '右中', rbi: 2 }
function extractHomeRuns(battingArr) {
  const RBI_MAP = { '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5 };
  const out = [];
  for (const b of battingArr) {
    b.innings?.forEach((cell, i) => {
      const m = cell?.match(/([^本\s\-]{1,4})本([①②③④⑤])?/);
      if (m) {
        out.push({
          hitter: b.name,
          inning: i + 1,
          dir: m[1],
          rbi: RBI_MAP[m[2]] || 1,
        });
      }
    });
  }
  return out;
}

// ===== エントリポイント =====
async function main() {
  const dateStr = process.argv[2] || new Date().toISOString().slice(0, 10);
  const parts = parseDate(dateStr);

  const segment = await findCarpGameSegment(parts);
  if (!segment) {
    console.error(`[fetch_game] No Carp game found for ${dateStr}`);
    process.exit(2);
  }
  console.error(`[fetch_game] Found game: ${segment}`);

  await sleep(SLEEP_MS);
  const facts = await fetchBoxFacts({ ...parts, segment });

  const output = {
    date: dateStr,
    segment,
    source: 'npb.jp',
    fetchedAt: new Date().toISOString(),
    facts,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(`[fetch_game] ERROR: ${e.message}`);
  process.exit(1);
});
