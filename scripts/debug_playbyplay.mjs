// NPB の playbyplay.html を取得して、一球速報の構造を調べるデバッグスクリプト
// 使い方: node scripts/debug_playbyplay.mjs YYYY-MM-DD

import * as cheerio from 'cheerio';
import { isCarpGame } from './team_codes.mjs';

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
  // スケジュールからカープのsegment取得
  const schedHtml = await fetchText(`https://npb.jp/games/${year}/schedule_${month}_detail.html`);
  const $s = cheerio.load(schedHtml);
  const links = new Set();
  $s(`a[href*="/scores/${year}/${month}${day}/"]`).each((_, el) => {
    const href = $s(el).attr('href') || '';
    const mm = href.match(new RegExp(`/scores/${year}/${month}${day}/([^/]+)/`));
    if (mm) links.add(mm[1]);
  });
  let segment = null;
  for (const seg of links) if (isCarpGame(seg)) { segment = seg; break; }
  if (!segment) { console.error('No Carp game'); process.exit(2); }
  console.log('Segment:', segment);

  await new Promise(r => setTimeout(r, 1500));
  const url = `https://npb.jp/scores/${year}/${month}${day}/${segment}/playbyplay.html`;
  console.log('URL:', url);
  const html = await fetchText(url);
  console.log('HTML size:', html.length);

  const $ = cheerio.load(html);

  console.log('\n=== Headings ===');
  $('h1, h2, h3, h4, h5').each((_, el) => {
    const t = $(el).text().trim();
    if (t) console.log(`  ${$(el).prop('tagName')}: ${t.slice(0, 50)}`);
  });

  console.log('\n=== All tables (with row count and first row) ===');
  $('table').slice(0, 20).each((i, t) => {
    const $t = $(t);
    const cls = $t.attr('class') || '';
    const id = $t.attr('id') || '';
    const rows = $t.find('tr').length;
    const firstRow = $t.find('tr').first();
    const cells = firstRow.find('th, td').map((_, c) => $(c).text().trim().replace(/\s+/g, ' ').slice(0, 18)).get();
    console.log(`  [${i}] cls="${cls}" id="${id}" rows=${rows}`);
    if (cells.length) console.log(`    row0: [${cells.join(' | ')}]`);
  });

  // セクション・場面ラベルを探す
  console.log('\n=== Inning markers (1回表 etc) ===');
  const inningPattern = /([1-9]|1[0-2])回(表|裏)/g;
  const inningMatches = new Set();
  let mt;
  while ((mt = inningPattern.exec(html)) !== null) inningMatches.add(mt[0]);
  console.log('  found:', Array.from(inningMatches).slice(0, 15).join(', '));

  // play-by-play テーブルの構造をより詳しく
  console.log('\n=== Tables containing 「打席」「打者」「結果」 ===');
  $('table').each((i, t) => {
    const txt = $(t).text();
    if (/打席|打者|結果|出塁|アウト|三振|安打|本塁打/.test(txt)) {
      const $t = $(t);
      console.log(`\n  [Table ${i}] cls="${$t.attr('class') || ''}" id="${$t.attr('id') || ''}" rows=${$t.find('tr').length}`);
      $t.find('tr').slice(0, 5).each((ri, r) => {
        const cells = $(r).find('th, td').map((_, c) => $(c).text().trim().replace(/\s+/g, ' ').slice(0, 25)).get();
        console.log(`    row${ri}: [${cells.join(' | ')}]`);
      });
    }
  });

  // section や div でイニング毎にまとまってるか
  console.log('\n=== Sections / divs with class hints ===');
  const classCounts = {};
  $('[class]').each((_, el) => {
    const cls = $(el).attr('class') || '';
    cls.split(/\s+/).forEach((c) => {
      if (c && /pbp|inning|play|batter|scoring/i.test(c)) {
        classCounts[c] = (classCounts[c] || 0) + 1;
      }
    });
  });
  Object.entries(classCounts).slice(0, 20).forEach(([c, n]) => console.log(`  .${c}: ${n}`));

  // 1回表のあたりのrawをサンプル表示
  console.log('\n=== Raw HTML around "1回表" (first occurrence) ===');
  const idx = html.indexOf('1回表');
  if (idx > -1) {
    console.log(html.slice(Math.max(0, idx - 300), idx + 800).replace(/\s+/g, ' ').slice(0, 1100));
  }
  console.log('\n=== END ===');
})().catch(e => { console.error('ERR:', e); process.exit(1); });
