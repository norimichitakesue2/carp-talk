// NPB公式公示ページからカープの「出場選手一覧」を取得してキャッシュJSONに保存。
// 公示は当日の昇格/抹消が即時反映されるので、NPB試合のroster.htmlよりも鮮度が高い。
// （試合直前まで roster.html が更新されない問題への対策）
//
// 出力: games/npb_official_roster_c.json
//
// 使い方:
//   node scripts/fetch_npb_official_roster.mjs [--dry]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { SHORT_NAMES } from './team_codes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(REPO_ROOT, 'games');

const UA = 'carp-talk-bot/0.1 (+https://carp-talk.vercel.app; fan-site, infrequent)';
const URL = 'https://npb.jp/announcement/roster/';
const dry = process.argv.includes('--dry');

// 「森浦 大輔」のようなフルネームから短縮名を作る（既存試合データと整合するため）
// 例: 森浦大輔→森浦、佐々木泰→佐々木、Ｔ．ハーン→ハーン、Ｅ．モンテロ→モンテロ
//   ※ ただし同姓選手がいる場合は名+名字の組合せで識別する必要があるが、
//      カープ現1軍にそういう紛らわしいケースは現状少ない
function toShortName(fullName) {
  if (!fullName) return '';
  // スペース除去
  let n = fullName.replace(/[\s　]/g, '');
  // 外国人選手の「Ｔ．」「Ｅ．」のようなイニシャル+全角ピリオドを除去
  n = n.replace(/^[Ａ-Ｚa-zA-Z]+[．.]/, '');
  // 「中村奨成」のように名前を含む場合の短縮対応
  // 既知の例外マッピング（同姓選手区別が必要なケース）
  const SHORT_OVERRIDE = {
    '中村奨成': '中村奨',
    '中村祐太': '中村',  // ※今は1軍に居ない想定
    '髙太一': '髙',
    '佐々木泰': '佐々木',
    '佐藤啓介': '佐藤啓',
    '齊藤汰直': '齊藤汰',
    '森翔平': '森翔',
    '森浦大輔': '森浦',
    '森下暢仁': '森下',
    '床田寛樹': '床田',
    '栗林良吏': '栗林',
    '中﨑翔太': '中﨑',
    '塹江敦哉': '塹江',
    '鈴木健矢': '鈴木',
    '岡本駿': '岡本',
    '玉村昇悟': '玉村',
    '遠藤淳志': '遠藤',
    '常廣羽也斗': '常廣',
    '島内颯太郎': '島内',
    '益田武尚': '益田',
    '辻大雅': '辻',
    '坂倉将吾': '坂倉',
    '石原貴規': '石原',
    '持丸泰輝': '持丸',
    '勝田成': '勝田',
    '矢野雅哉': '矢野',
    '小園海斗': '小園',
    '菊池涼介': '菊池',
    '林晃汰': '林',
    '辰見鴻之介': '辰見',
    '前川誠太': '前川',
    '二俣翔一': '二俣',
    '野間峻祥': '野間',
    '大盛穂': '大盛',
    '田村俊介': '田村',
    '秋山翔吾': '秋山',
    '平川蓮': '平川',
    'ファビアン': 'ファビアン',
    'ハーン': 'ハーン',
    'モンテロ': 'モンテロ',
    'ターノック': 'ターノック',
  };
  if (SHORT_OVERRIDE[n]) return SHORT_OVERRIDE[n];
  // フォールバック: 漢字2文字以上の姓と思われる先頭2文字を採用
  return n;
}

// 守備位置「投手」→「投」、「捕手」→「捕」、「内野手」→「内」、「外野手」→「外」
const POS_MAP = { '投手': '投', '捕手': '捕', '内野手': '内', '外野手': '外' };

async function main() {
  console.error('[fetch_npb_official_roster] Fetching NPB公示 …');
  const html = await fetch(URL, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja' } }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  const $ = cheerio.load(html);

  // 公示ページには「広島東洋カープ」が複数出現する:
  //   (1) 出場選手登録セクション内の各球団欄（昇格・抹消があった日のみ）
  //   (2) 出場選手一覧セクションのカープ全選手リスト ← これが欲しい
  //
  // (1) のセクションには「以上 N 名」が無いため、貪欲でない regex でも
  // 次の「以上 N 名」まで [\s\S]*? が他球団を巻き込んで阪神等のデータを
  // 拾ってしまう事故が起きる（5/20 のキャッシュが阪神38人になった原因）。
  //
  // 対策: 「他球団名」が間に出現したらマッチ失敗→次の「広島東洋カープ」を試す。
  const fullText = $('body').text();
  // 他11球団。これが本文中に出現する前に「以上 N 名」に到達したセクションのみ採用。
  const OTHER_TEAMS_RX = /(阪神タイガース|読売ジャイアンツ|横浜DeNAベイスターズ|東京ヤクルトスワローズ|中日ドラゴンズ|福岡ソフトバンクホークス|北海道日本ハムファイターズ|千葉ロッテマリーンズ|オリックス・バファローズ|オリックスバファローズ|東北楽天ゴールデンイーグルス|埼玉西武ライオンズ)/;
  const carpRx = /広島東洋カープ\s*投手([\s\S]*?)以上(\d+)名/g;
  let carpMatch = null;
  let _m;
  while ((_m = carpRx.exec(fullText)) !== null) {
    // セクション本体に他球団名が含まれていなければ、純粋なカープセクション
    if (!OTHER_TEAMS_RX.test(_m[1])) {
      carpMatch = _m;
      break;
    }
  }
  if (!carpMatch) {
    throw new Error('広島東洋カープの出場選手一覧セクションが見つからない（他球団に汚染されないマッチが0件）');
  }
  // 「投手」を含むセクション本体に「投手」プレフィックスを足し戻す（regexで除いたため）
  carpMatch[1] = '投手' + carpMatch[1];
  const carpSection = carpMatch[1];
  const expectedCount = parseInt(carpMatch[2], 10);

  // 行: 「投手 19 床田 寛樹」「内野手 10 佐々木 泰」のような並び
  // 改行で区切られていない可能性があるので、全角空白も含めて整理
  const cleaned = carpSection.replace(/[\t\r]/g, ' ').replace(/[ ]+/g, ' ').trim();

  // 「投手」「捕手」「内野手」「外野手」+ スペース + 背番号(数字または記号) + スペース + フルネーム
  // フルネームは「姓 名」の2語に分かれるが、姓が1文字（髙・林など）もありうるので
  // 先頭1文字+(空白+1文字以上の名)パターンを優先、または2文字以上の連続非空白文字
  const rxRow = /(投手|捕手|内野手|外野手)\s*([0-9０-９]+|00|００)\s+([^\s\d投捕内外](?:[^\s]*|\s[^\s]+))/g;
  const players = [];
  let m;
  while ((m = rxRow.exec(cleaned)) !== null) {
    const posLong = m[1];
    const num = m[2].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const fullName = m[3].trim().replace(/\s+/g, '');
    players.push({
      pos: POS_MAP[posLong] || '?',
      number: num,
      fullName,
      name: toShortName(fullName),
    });
  }

  console.error(`[fetch_npb_official_roster] パース: ${players.length}名 (期待${expectedCount}名)`);
  if (players.length === 0) {
    throw new Error('選手リストのパースに失敗');
  }
  if (Math.abs(players.length - expectedCount) > 2) {
    console.error(`[fetch_npb_official_roster] ⚠️ 件数差大 (差${Math.abs(players.length - expectedCount)})。`);
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    sourceUrl: URL,
    note: 'NPB公式公示の「広島東洋カープ 出場選手一覧」を直接スクレイプ。試合直前まで更新されないNPB box の roster.html より鮮度高い。',
    expectedCount,
    players,
  };

  if (dry) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  await fs.mkdir(GAMES_DIR, { recursive: true });
  const outPath = path.join(GAMES_DIR, 'npb_official_roster_c.json');
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[fetch_npb_official_roster] Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(`[fetch_npb_official_roster] ERROR: ${e.message}`);
  process.exit(1);
});
