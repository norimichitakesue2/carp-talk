// Yahoo!プロ野球の日次スケジュールページから、カープの試合の gameId を取得できるか調査
// 使い方: node scripts/debug_yahoo_schedule.mjs YYYY-MM-DD
// 例: node scripts/debug_yahoo_schedule.mjs 2026-04-26

import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

const dateStr = process.argv[2] || new Date().toISOString().slice(0, 10);
const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
if (!m) { console.error('YYYY-MM-DD'); process.exit(1); }
const ymd = m[1] + m[2] + m[3];

(async () => {
  // よくある Yahoo schedule URL 候補
  const urls = [
    `https://baseball.yahoo.co.jp/npb/schedule/?date=${ymd}`,
    `https://baseball.yahoo.co.jp/npb/schedule/?selectDate=${ymd}`,
    `https://baseball.yahoo.co.jp/npb/schedule`,
  ];
  let html = null, foundUrl = null;
  for (const url of urls) {
    try {
      console.log('Trying:', url);
      html = await fetchText(url);
      foundUrl = url;
      console.log('  → OK', html.length, 'bytes');
      break;
    } catch (e) {
      console.log('  → FAIL', e.message);
    }
  }
  if (!html) { console.error('No URL worked'); process.exit(1); }

  const $ = cheerio.load(html);
  console.log('\n=== Page title ===');
  console.log(' ', $('title').text().trim());

  // /npb/game/{id}/top|index|top のリンクを全列挙
  console.log('\n=== /npb/game/ links ===');
  const gameLinks = new Set();
  $('a[href*="/npb/game/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const mm = href.match(/\/npb\/game\/(\d+)/);
    if (mm) {
      const text = $(el).text().trim().replace(/\s+/g, ' ').slice(0, 60);
      gameLinks.add(`${mm[1]} :: ${text} :: ${href}`);
    }
  });
  Array.from(gameLinks).slice(0, 20).forEach((l) => console.log(' ', l));

  // カープ・広島の文字を含む周辺
  console.log('\n=== Carp game search ===');
  ['広島', 'カープ'].forEach((kw) => {
    const idx = html.indexOf(kw);
    if (idx > -1) {
      console.log(`  found "${kw}" at offset ${idx}`);
      console.log(`  surrounding: ${html.slice(Math.max(0, idx - 100), idx + 200).replace(/\s+/g, ' ')}`);
    }
  });

  // 予告先発の名前が schedule に出てるかも
  console.log('\n=== "予告" in schedule ===');
  const yIdx = html.indexOf('予告');
  if (yIdx > -1) {
    console.log(' ', html.slice(Math.max(0, yIdx - 200), yIdx + 600).replace(/\s+/g, ' ').slice(0, 800));
  } else {
    console.log('  not found');
  }

  console.log('\n=== END ===');
})().catch((e) => { console.error('ERR:', e); process.exit(1); });
