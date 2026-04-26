// Yahoo!プロ野球の試合トップページを取得して、予告先発の場所を探るデバッグスクリプト
// 使い方: node scripts/debug_yahoo.mjs <gameId>
// 例: node scripts/debug_yahoo.mjs 2021038772
//
// Yahoo のページから「予告先発」の表示位置と HTML構造を特定するため

import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

const gameId = process.argv[2];
if (!gameId) {
  console.error('Usage: node scripts/debug_yahoo.mjs <gameId>');
  console.error('  e.g. node scripts/debug_yahoo.mjs 2021038772');
  process.exit(1);
}

(async () => {
  const url = `https://baseball.yahoo.co.jp/npb/game/${gameId}/top`;
  console.log('URL:', url);

  const html = await fetchText(url);
  console.log('HTML size:', html.length, 'bytes');

  const $ = cheerio.load(html);

  console.log('\n=== Page title ===');
  console.log(' ', $('title').text().trim());

  console.log('\n=== Headings (h1-h4) ===');
  $('h1, h2, h3, h4').each((i, el) => {
    const t = $(el).text().trim();
    if (t) console.log(`  ${$(el).prop('tagName')}: ${t.slice(0, 60)}`);
  });

  // 予告先発という文字列を含む要素の周辺を探索
  console.log('\n=== "予告先発" mentions ===');
  let foundCount = 0;
  $('*').each((_, el) => {
    if (foundCount >= 10) return;
    const txt = $(el).clone().children().remove().end().text().trim();
    if (/予告先発|先発予告|^先発$/.test(txt) && txt.length < 30) {
      const tag = $(el).prop('tagName');
      const cls = $(el).attr('class') || '';
      const id = $(el).attr('id') || '';
      const parentText = $(el).parent().text().replace(/\s+/g, ' ').trim().slice(0, 200);
      console.log(`  <${tag} class="${cls}" id="${id}">${txt}</${tag}>`);
      console.log(`    parent text: ${parentText}`);
      foundCount++;
    }
  });

  // 投手名らしき場所（リンクで /player/ を含む）
  console.log('\n=== Player links (/player/) ===');
  const playerLinks = [];
  $('a[href*="/player/"]').each((_, el) => {
    const name = $(el).text().trim();
    const href = $(el).attr('href') || '';
    if (name) playerLinks.push({ name, href: href.slice(0, 80) });
  });
  console.log(`  total: ${playerLinks.length}`);
  playerLinks.slice(0, 12).forEach((p) => console.log(`  - ${p.name} → ${p.href}`));

  // bb-... という class が Yahoo Baseball の典型
  console.log('\n=== bb-* class samples ===');
  const bbClasses = new Set();
  $('[class*="bb-"]').each((_, el) => {
    const cls = $(el).attr('class') || '';
    cls.split(/\s+/).forEach((c) => { if (c.startsWith('bb-')) bbClasses.add(c); });
  });
  Array.from(bbClasses).slice(0, 25).forEach((c) => console.log(`  .${c}`));

  // チーム名・スコア表示の場所
  console.log('\n=== Score / team display ===');
  ['広島', 'カープ', '阪神', 'タイガース'].forEach((kw) => {
    const m = html.indexOf(kw);
    if (m > -1) {
      const slice = html.slice(Math.max(0, m - 50), m + 200).replace(/\s+/g, ' ');
      console.log(`  "${kw}" first occurrence: ...${slice}...`);
    }
  });

  console.log('\n=== Raw HTML around "予告" ===');
  const yokokuIdx = html.indexOf('予告');
  if (yokokuIdx > -1) {
    console.log(html.slice(Math.max(0, yokokuIdx - 200), yokokuIdx + 500).replace(/\s+/g, ' ').slice(0, 800));
  } else {
    console.log('  "予告" not found in HTML');
  }
  console.log('\n=== END ===');
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
