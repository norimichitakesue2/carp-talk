// nf3 からカープ全打者の通算/対右/対左 成績を取得してキャッシュJSONに保存。
// 1日1回 GitHub Actions で実行する想定（毎試合ごとに15-20 fetch を nf3 に投げないため）。
//
// 出力: games/nf3_carp_batters.json
//
// 使い方:
//   node scripts/refresh_carp_batters.mjs           # 全部更新
//   node scripts/refresh_carp_batters.mjs --dry     # 取得だけして stdout に出す

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCarpBatterList, fetchBatterStats } from './fetch_nf3.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'games', 'nf3_carp_batters.json');

const SLEEP_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hasArg = (n) => process.argv.includes(`--${n}`);

// 投手の打撃成績ページと打者ページを区別するため、既知のカープ投手リストを使う。
// この一覧は固定でOK（投手は打撃成績がほぼ無く、対右/左データも意味薄）。
// 漏れた選手は fallback として「fetch後に打席数で判定」で除外する。
const KNOWN_PITCHER_KEYWORDS = [
  // 既存
  '齊藤汰', '森浦', '大瀬良', '森翔平', '常廣', '森下暢', '床田', '栗林', '中﨑',
  '塹江', '島内', '岡本駿', 'ハーン', 'ターノック', '遠藤淳', '黒原', '玉村',
  // 追加 (上の漏れ)
  '益田武', '赤木', '辻大雅', '鈴木健', '髙太一', '森翔',
];
function isLikelyPitcher(name) {
  return KNOWN_PITCHER_KEYWORDS.some(k => name.includes(k));
}

// fallback: 通算打席数が極端に少ない選手は投手扱い（refreshで除外）
const MIN_PA_FOR_BATTER = 5;

async function main() {
  const dry = hasArg('dry');
  console.error('[refresh_carp_batters] Fetching batter list from nf3...');
  const list = await fetchCarpBatterList();
  console.error(`[refresh_carp_batters] Got ${list.length} entries`);

  // 投手と思われる選手を除外
  const batters = list.filter(p => !isLikelyPitcher(p.name));
  console.error(`[refresh_carp_batters] After pitcher filter: ${batters.length} batters`);
  console.error(`  Excluded as pitcher: ${list.length - batters.length}`);
  console.error(`  Targets: ${batters.map(b => `#${b.number} ${b.name}`).join(', ')}`);

  const results = [];
  let okCount = 0;
  for (const b of batters) {
    await sleep(SLEEP_MS);
    try {
      const stat = await fetchBatterStats(b.number);
      // 名前 fallback (パース失敗時はリスト名を採用)
      if (!stat.name) stat.name = b.name;
      // fallback フィルタ: 打席数が少なすぎる(=投手扱い)選手は除外
      const pa = stat.career?.pa ?? 0;
      if (pa < MIN_PA_FOR_BATTER) {
        console.error(`[refresh_carp_batters] - #${b.number} ${stat.name} skipped (PA=${pa}<${MIN_PA_FOR_BATTER}, likely pitcher)`);
        continue;
      }
      results.push(stat);
      okCount++;
      const c = stat.career;
      const vsR = stat.vsRight;
      const vsL = stat.vsLeft;
      console.error(`[refresh_carp_batters] ✓ #${b.number} ${stat.name} 通算${c?.avg || '?'} 対右${vsR?.avg || '?'} 対左${vsL?.avg || '?'}`);
    } catch (e) {
      console.error(`[refresh_carp_batters] ✗ #${b.number} ${b.name} fetch error: ${e.message}`);
      // 失敗してもそのまま進む。次回更新で取れる
    }
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    sourceUrl: 'https://nf3.sakura.ne.jp/php/stat_disp/stat_disp.php?y=0&leg=0&tm=C&fp=0&dn=1&dk=0',
    note: 'カープ打者の通算 + 対右投手 + 対左投手 成績。fetch_nf3.mjs 経由。1日1回 refresh_carp_batters.mjs で更新',
    batters: results,
  };

  if (dry) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[refresh_carp_batters] Wrote ${OUT_PATH} (${okCount}/${batters.length} batters)`);
}

main().catch((e) => {
  console.error('[refresh_carp_batters] FATAL:', e);
  process.exit(1);
});
