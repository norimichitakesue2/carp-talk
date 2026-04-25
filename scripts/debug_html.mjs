// デバッグ用：NPB box.html のHTML構造をダンプして、パーサーを書くために情報を集める
// 使い方:
//   node scripts/debug_html.mjs YYYY-MM-DD

import * as cheerio from 'cheerio';
import { TEAM_BY_CODE, isCarpGame } from './team_codes.mjs';

const UA = 'carp-talk-bot/0.1 (+https://carp-talk.vercel.app; debug)';

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

const dateStr = process.argv[2] || new Date().toISOString().slice(0, 10);
const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
if (!m) { console.error('YYYY-MM-DD'); process.exit(1); }
const [_, year, month, day] = m;

(async () => {
  // 1) 月次スケジュールからカープのURLを探す
  const schedHtml = await fetchText(`https://npb.jp/games/${year}/schedule_${month}_detail.html`);
  const $s = cheerio.load(schedHtml);
  const links = new Set();
  $s(`a[href*="/scores/${year}/${month}${day}/"]`).each((_, el) => {
    const href = $s(el).attr('href') || '';
    const mm = href.match(new RegExp(`/scores/${year}/${month}${day}/([^/]+)/`));
    if (mm) links.add(mm[1]);
  });
  console.log('=== Game segments found ===');
  for (const seg of links) console.log(`  ${seg}  carp=${isCarpGame(seg)}`);

  let segment = null;
  for (const seg of links) if (isCarpGame(seg)) { segment = seg; break; }
  if (!segment) { console.error('No Carp game'); process.exit(2); }
  console.log(`\n=== Carp game: ${segment} ===`);

  // 2) box.html を取得
  await new Promise(r => setTimeout(r, 1500));
  const boxHtml = await fetchText(`https://npb.jp/scores/${year}/${month}${day}/${segment}/box.html`);
  const $ = cheerio.load(boxHtml);

  // 3) 試合情報まわり（heading, venue, status, etc.）
  console.log('\n=== Headings ===');
  $('h1, h2, h3').slice(0, 8).each((i, el) => {
    console.log(`  ${$(el).prop('tagName')}: ${$(el).text().trim().slice(0, 80)}`);
  });

  // 4) すべてのテーブルの構造（最初の数行）
  console.log('\n=== Tables (first rows preview) ===');
  $('table').slice(0, 14).each((i, t) => {
    const $t = $(t);
    const cls = $t.attr('class') || '';
    const id = $t.attr('id') || '';
    const cap = $t.find('caption').first().text().trim();
    const rows = $t.find('tr');
    console.log(`\n[table ${i}] class="${cls}" id="${id}" caption="${cap}" rows=${rows.length}`);
    rows.slice(0, 3).each((ri, r) => {
      const cells = $(r).find('th, td').map((_, c) => $(c).text().trim().replace(/\s+/g, ' ').slice(0, 14)).get();
      console.log(`  row${ri}: [${cells.join(' | ')}]`);
    });
  });

  // 5) スコアボードらしき場所をテキスト検索
  console.log('\n=== Possible scoreboard text ===');
  const bodyText = $('body').text();
  const score = bodyText.match(/[【［]?スコア[】］]?\s*[\s\S]{0,200}/);
  if (score) console.log('  found:', score[0].replace(/\s+/g, ' ').slice(0, 200));

  // 6) <img alt="..."> でスコア画像が使われているかチェック
  console.log('\n=== Image alts (first 20) ===');
  $('img').slice(0, 20).each((i, el) => {
    const alt = $(el).attr('alt') || '';
    const src = $(el).attr('src') || '';
    if (alt) console.log(`  alt="${alt}" src="${src.slice(0, 60)}"`);
  });

  // 7) 投手・本塁打・バッテリー周辺のテキスト
  console.log('\n=== Battery / Home runs / Pitcher text ===');
  ['バッテリー', '勝投手', '敗投手', 'セーブ', '本塁打'].forEach((kw) => {
    const idx = bodyText.indexOf(kw);
    if (idx > -1) {
      console.log(`  ${kw}: ${bodyText.slice(idx, idx + 200).replace(/\s+/g, ' ')}`);
    }
  });

  // 8) HTMLの一部を直接ダンプ（先頭3000文字＋scoreboardっぽい場所）
  console.log('\n=== Raw HTML (first 600 chars after <body>) ===');
  const bodyMatch = boxHtml.match(/<body[^>]*>([\s\S]{0,3500})/);
  if (bodyMatch) console.log(bodyMatch[1].replace(/\s+/g, ' ').slice(0, 600));

  console.log('\n=== END DEBUG ===');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
