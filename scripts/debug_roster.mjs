// roster.html のHTML構造をダンプする
// 使い方: node scripts/debug_roster.mjs YYYY-MM-DD
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
if (!m) { console.error('YYYY-MM-DD required'); process.exit(1); }
const [_, year, month, day] = m;

(async () => {
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
  const url = `https://npb.jp/scores/${year}/${month}${day}/${segment}/roster.html`;
  console.log('URL:', url);
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  // 全 heading をリスト
  console.log('\n=== All headings ===');
  $('h1, h2, h3, h4, h5').each((i, el) => {
    console.log(`  ${$(el).prop('tagName')}: "${$(el).text().trim().slice(0, 40)}"`);
  });

  // 全 table 数と概要
  console.log('\n=== All tables (with player link count) ===');
  $('table').each((i, t) => {
    const $t = $(t);
    const playerLinks = $t.find('a[href*="/bis/players/"]').length;
    const cls = $t.attr('class') || '';
    const id = $t.attr('id') || '';
    console.log(`  [${i}] class="${cls}" id="${id}" rows=${$t.find('tr').length} playerLinks=${playerLinks}`);
    if (playerLinks > 0) {
      // 最初の3選手だけ表示
      const names = $t.find('a[href*="/bis/players/"]').slice(0, 3).map((_, a) => $(a).text().trim()).get();
      console.log(`    sample: ${names.join(' / ')}`);
      // 親ヘッダーを探索
      const prev = $t.prevAll('h1, h2, h3, h4').first();
      const parentH = $t.parent().find('h1, h2, h3, h4').first();
      const grandH = $t.parent().parent().find('h1, h2, h3, h4').first();
      console.log(`    prev-heading: "${prev.text().trim().slice(0, 30)}"`);
      console.log(`    parent-heading: "${parentH.text().trim().slice(0, 30)}"`);
      console.log(`    grand-heading: "${grandH.text().trim().slice(0, 30)}"`);
      console.log(`    parent tagName: ${$t.parent().prop('tagName')} class="${$t.parent().attr('class') || ''}"`);
    }
  });

  // Raw HTML サンプル
  console.log('\n=== Raw HTML around first roster table ===');
  const firstRosterTable = $('table').filter((_, t) => $(t).find('a[href*="/bis/players/"]').length >= 10).first();
  if (firstRosterTable.length) {
    const html2 = $.html(firstRosterTable.parent());
    console.log(html2.replace(/\s+/g, ' ').slice(0, 1500));
  }
  console.log('\n=== END ===');
})().catch(e => { console.error('ERR:', e); process.exit(1); });
