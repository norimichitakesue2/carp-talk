// nf3 からカープ全投手の今季成績を取得してキャッシュJSONに保存。
// refresh_carp_batters.mjs の投手版。シーズン総括の投手成績に使う。
//
// 出力: games/nf3_carp_pitchers.json
// 使い方: node scripts/refresh_carp_pitchers.mjs [--dry]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCarpPitcherList, fetchPitcherStats, teamLookup } from './fetch_nf3.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'games', 'nf3_carp_pitchers.json');
const dry = process.argv.includes('--dry');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const carp = teamLookup('広島');
  if (!carp) { console.error('[refresh_pitchers] teamLookup(広島) failed'); process.exit(1); }

  console.error('[refresh_pitchers] Fetching pitcher list from nf3...');
  const list = await fetchCarpPitcherList();
  console.error(`[refresh_pitchers] ${list.length} pitchers`);
  if (list.length === 0) { console.error('[refresh_pitchers] list empty — nf3 構造変化の可能性'); process.exit(1); }

  const pitchers = [];
  for (const p of list) {
    try {
      const stat = await fetchPitcherStats(carp, p.number);
      pitchers.push({ number: p.number, name: p.name, ...stat });
      console.error(`[refresh_pitchers] ✓ #${p.number} ${p.name}: 防御率${stat.era} ${stat.ip}回 ${stat.wins}勝${stat.losses}敗${stat.saves}S`);
    } catch (e) {
      console.error(`[refresh_pitchers] ✗ #${p.number} ${p.name}: ${e.message}`);
    }
    await sleep(400);
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    sourceUrl: 'https://nf3.sakura.ne.jp/php/stat_disp/stat_disp.php?y=0&leg=0&tm=C&fp=1',
    note: 'カープ投手の今季成績（防御率・登板・先発/救援・勝敗・セーブ等）。nf3 2026年版。',
    pitchers,
  };

  if (dry) { console.log(JSON.stringify(out, null, 2)); return; }
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.error(`[refresh_pitchers] Wrote ${OUT_PATH} (${pitchers.length} pitchers)`);
}

main().catch(e => { console.error(`[refresh_pitchers] ERROR: ${e.message}`); process.exit(1); });
