// 直近N試合のカープ各打者の打撃成績を集計して「調子」を算出する。
// games/YYYY-MM-DD.json の carp_batting フィールドを読んで合算する。
// 出力: games/recent_form.json
//
// 使い方:
//   node scripts/build_recent_form.mjs [基準日 YYYY-MM-DD] [--games N] [--dry]
//   基準日省略時は今日(JST)。--games 省略時は 6。
//   日数ではなく「実際に試合があった直近N試合」を集計（オフ日に左右されない）。
//
// 調子アイコン (パワプロ風 5段階) は打率/防御率ベースで判定。
// サンプル(打数/投球回)が少ない場合は「様子見」にする。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(REPO_ROOT, 'games');

// 直近何試合を集計対象にするか（--games N、デフォルト6）
const argGames = (() => {
  const i = process.argv.indexOf('--games');
  if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10) || 6;
  return 6;
})();
const dry = process.argv.includes('--dry');
const baseDate = (() => {
  const a = process.argv.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
  if (a) return a;
  // JST today
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
})();

// 調子判定: OPS を主指標に、三振率で微調整して5段階。
//   ベーススコア = OPS
//   三振率 K/(打数+四球) が高ければ減点、低ければ加点
// サンプル(打数)が少ない選手のノイズ対策:
//   - 打数8未満は「様子見」（判定不能）
//   - 打数8〜11は極端評価(絶好調/絶不調)を避け、好調/不調どまりにする
function judgeForm(ab, ops, bb, k) {
  const NONE  = { icon: '－', label: '様子見', level: 0, cls: 'form-none' };
  const HOT2  = { icon: '↑↑', label: '絶好調', level: 2,  cls: 'form-hot2' };
  const HOT1  = { icon: '↑',  label: '好調',   level: 1,  cls: 'form-hot1' };
  const EVEN  = { icon: '→',  label: '普通',   level: 0,  cls: 'form-even' };
  const COLD1 = { icon: '↓',  label: '不調',   level: -1, cls: 'form-cold1' };
  const COLD2 = { icon: '↓↓', label: '絶不調', level: -2, cls: 'form-cold2' };

  if (ab < 8) return NONE;                       // サンプル不足

  // 三振率（打席ベース近似）で OPS を微補正
  const pa = ab + bb;
  const kRate = pa > 0 ? k / pa : 0;
  let score = ops;
  if (kRate >= 0.35) score -= 0.07;        // 三振が多すぎる → 減点
  else if (kRate >= 0.28) score -= 0.035;
  else if (kRate <= 0.10) score += 0.03;   // 三振が少ない → 加点

  const small = ab < 12;                         // 8〜11打数は極端評価を避ける

  if (score >= 0.900) return small ? HOT1 : HOT2;
  if (score >= 0.720) return HOT1;
  if (score >= 0.580) return EVEN;
  if (score >= 0.450) return COLD1;
  return small ? COLD1 : COLD2;
}

function calcAvg(h, ab) {
  if (!ab) return '.000';
  return (h / ab).toFixed(3).replace(/^0/, '');
}

// 投手の調子判定: 直近の防御率(ERA)ベースで5段階。
//   - 投球回3未満(アウト9未満)は「様子見」
//   - 防御率 = 自責点 * 27 / アウト数
function judgeFormPitcher(outs, earnedRuns) {
  const NONE  = { icon: '－', label: '様子見', level: 0, cls: 'form-none' };
  const HOT2  = { icon: '↑↑', label: '絶好調', level: 2,  cls: 'form-hot2' };
  const HOT1  = { icon: '↑',  label: '好調',   level: 1,  cls: 'form-hot1' };
  const EVEN  = { icon: '→',  label: '普通',   level: 0,  cls: 'form-even' };
  const COLD1 = { icon: '↓',  label: '不調',   level: -1, cls: 'form-cold1' };
  const COLD2 = { icon: '↓↓', label: '絶不調', level: -2, cls: 'form-cold2' };

  if (outs < 9) return NONE;                     // 投球回3未満はサンプル不足
  const era = (earnedRuns * 27) / outs;
  const small = outs < 18;                       // 6回未満は極端評価を避ける

  if (era < 1.50) return small ? HOT1 : HOT2;
  if (era < 2.50) return HOT1;
  if (era < 3.80) return EVEN;
  if (era < 5.50) return COLD1;
  return small ? COLD1 : COLD2;
}

// アウト数を "X回Y/3" 形式に
function outsToIp(outs) {
  const whole = Math.floor(outs / 3);
  const frac = outs % 3;
  return frac ? `${whole}回${frac}/3` : `${whole}回`;
}

async function main() {
  // games ディレクトリから「基準日以前で carp_batting を持つ試合」を新しい順に列挙し、
  // 直近 argGames 試合だけを集計対象にする（オフ日に左右されない試合数ベース）。
  let allFiles;
  try { allFiles = await fs.readdir(GAMES_DIR); }
  catch { allFiles = []; }
  const candidateDates = allFiles
    .filter((fn) => /^\d{4}-\d{2}-\d{2}\.json$/.test(fn))
    .map((fn) => fn.replace('.json', ''))
    .filter((d) => d <= baseDate)
    .sort()
    .reverse();   // 新しい順

  // 直近 argGames 試合（carp_batting を持つもの）を収集
  const targetGames = [];   // { date, json }
  for (const date of candidateDates) {
    if (targetGames.length >= argGames) break;
    let g;
    try { g = JSON.parse(await fs.readFile(path.join(GAMES_DIR, `${date}.json`), 'utf8')); }
    catch { continue; }
    const hasBatting = Array.isArray(g.carp_batting) && g.carp_batting.length > 0;
    const hasPitching = Array.isArray(g.carp_pitching) && g.carp_pitching.length > 0;
    if (!hasBatting && !hasPitching) continue;   // 試合データが無い日はスキップ
    targetGames.push({ date, json: g });
  }
  // 古い順に並べ直す（集計順序は問わないが dates 表示用）
  targetGames.reverse();

  const rangeStart = targetGames.length ? targetGames[0].date : baseDate;
  const rangeEnd   = targetGames.length ? targetGames[targetGames.length - 1].date : baseDate;
  console.error(`[recent_form] Aggregating ${targetGames.length} games: ${rangeStart} 〜 ${rangeEnd} (直近${argGames}試合)`);

  const perPlayer = {};   // name -> {games, ab, r, h, rbi, sb, hr, dates:[]}
  const perPitcher = {};  // name -> {games, outs, er, r, h, hr, bb, k, pitches, win, loss, save, hold}
  let foundGames = 0;
  let foundPitchingGames = 0;

  for (const { date, json: g } of targetGames) {
    // --- 打者集計 ---
    const batting = g.carp_batting;
    if (Array.isArray(batting) && batting.length > 0) {
      foundGames++;
      for (const b of batting) {
        if (!b.name) continue;
        if (!perPlayer[b.name]) {
          perPlayer[b.name] = {
            name: b.name, games: 0, ab: 0, r: 0, h: 0, rbi: 0, sb: 0, hr: 0,
            k: 0, bb: 0, double: 0, triple: 0, single: 0, hbp: 0, sf: 0, dates: [],
          };
        }
        const pp = perPlayer[b.name];
        pp.games  += 1;
        pp.ab     += b.ab     ?? 0;
        pp.r      += b.r      ?? 0;
        pp.h      += b.h      ?? 0;
        pp.rbi    += b.rbi    ?? 0;
        pp.sb     += b.sb     ?? 0;
        pp.hr     += b.hr     ?? 0;
        pp.k      += b.k      ?? 0;
        pp.bb     += b.bb     ?? 0;
        pp.double += b.double ?? 0;
        pp.triple += b.triple ?? 0;
        pp.single += b.single ?? 0;
        pp.hbp    += b.hbp    ?? 0;
        pp.sf     += b.sf     ?? 0;
        pp.dates.push(date);
      }
    }

    // --- 投手集計 ---
    const pitching = g.carp_pitching;
    if (Array.isArray(pitching) && pitching.length > 0) {
      foundPitchingGames++;
      for (const p of pitching) {
        if (!p.name) continue;
        if (!perPitcher[p.name]) {
          perPitcher[p.name] = {
            name: p.name, games: 0, outs: 0, er: 0, r: 0, h: 0, hr: 0,
            bb: 0, k: 0, pitches: 0, win: 0, loss: 0, save: 0, hold: 0, dates: [],
          };
        }
        const pp = perPitcher[p.name];
        pp.games   += 1;
        pp.outs    += p.outs        ?? 0;
        pp.er      += p.earnedRuns  ?? 0;
        pp.r       += p.runs        ?? 0;
        pp.h       += p.hitsAllowed ?? 0;
        pp.hr      += p.hrAllowed   ?? 0;
        pp.bb      += p.walks       ?? 0;
        pp.k       += p.strikeouts  ?? 0;
        pp.pitches += p.pitches     ?? 0;
        if (p.result === 'win')  pp.win  += 1;
        if (p.result === 'loss') pp.loss += 1;
        if (p.result === 'save') pp.save += 1;
        if (p.result === 'hold') pp.hold += 1;
        pp.dates.push(date);
      }
    }
  }

  console.error(`[recent_form] Found ${foundGames} batting / ${foundPitchingGames} pitching games`);

  // 投手が代打・投手の打席で carp_batting に混ざるので、野手リストから除外する。
  // 期間中に1度でも登板した選手＝投手とみなす。
  const pitcherNames = new Set(Object.keys(perPitcher));
  for (const name of Object.keys(perPlayer)) {
    if (pitcherNames.has(name)) {
      delete perPlayer[name];
    }
  }

  // 各選手の派生指標を計算（当該試合数における OPS を含む）
  const players = Object.values(perPlayer).map((pp) => {
    const ab = pp.ab;
    const avg = ab ? pp.h / ab : 0;
    // 単打数: イニング解析の single を使う。万一ズレたら H から逆算で補正
    const singles = (pp.single != null && pp.single >= 0)
      ? pp.single
      : Math.max(0, pp.h - pp.double - pp.triple - pp.hr);
    // 塁打 (TB) = 単打 + 2*二塁打 + 3*三塁打 + 4*本塁打
    const tb = singles + pp.double * 2 + pp.triple * 3 + pp.hr * 4;
    const slg = ab ? tb / ab : 0;
    // 出塁率 OBP = (安打 + 四球 + 死球) / (打数 + 四球 + 死球 + 犠飛)
    const obpDenom = ab + pp.bb + pp.hbp + pp.sf;
    const obp = obpDenom ? (pp.h + pp.bb + pp.hbp) / obpDenom : 0;
    const ops = obp + slg;
    const fmt3 = (n) => n.toFixed(3).replace(/^0/, '');
    const form = judgeForm(ab, ops, pp.bb, pp.k);
    const summary = `直近${pp.games}試合 ${pp.ab}打数${pp.h}安打 ${calcAvg(pp.h, pp.ab)}` +
                    ` OPS${fmt3(ops)}` +
                    (pp.hr ? ` ${pp.hr}本` : '') +
                    (pp.rbi ? ` ${pp.rbi}打点` : '') +
                    (pp.bb ? ` ${pp.bb}四球` : '') +
                    (pp.k  ? ` ${pp.k}三振`  : '') +
                    (pp.sb ? ` ${pp.sb}盗塁` : '');
    return {
      name: pp.name,
      games: pp.games,
      ab: pp.ab, r: pp.r, h: pp.h, rbi: pp.rbi, sb: pp.sb, hr: pp.hr, k: pp.k, bb: pp.bb,
      double: pp.double, triple: pp.triple, single: singles, hbp: pp.hbp, sf: pp.sf,
      avg: calcAvg(pp.h, pp.ab),
      avg_num: Number(avg.toFixed(3)),
      obp: fmt3(obp),
      slg: fmt3(slg),
      ops: fmt3(ops),
      ops_num: Number(ops.toFixed(3)),
      form,
      summary,
    };
  });

  // 並び: 調子レベル降順 → 打率降順
  players.sort((a, b) => {
    if (b.form.level !== a.form.level) return b.form.level - a.form.level;
    return b.avg_num - a.avg_num;
  });

  // 投手の派生指標を計算
  const pitchers = Object.values(perPitcher).map((pp) => {
    const era = pp.outs > 0 ? (pp.er * 27) / pp.outs : 0;
    const form = judgeFormPitcher(pp.outs, pp.er);
    const ipStr = outsToIp(pp.outs);
    const resultParts = [];
    if (pp.win)  resultParts.push(`${pp.win}勝`);
    if (pp.loss) resultParts.push(`${pp.loss}敗`);
    if (pp.save) resultParts.push(`${pp.save}S`);
    if (pp.hold) resultParts.push(`${pp.hold}H`);
    const summary = `直近${pp.games}登板 ${ipStr} 防御率${era.toFixed(2)}` +
                    ` 自責${pp.er} 被安${pp.h} 奪三振${pp.k}` +
                    (resultParts.length ? ` ${resultParts.join('')}` : '');
    return {
      name: pp.name,
      games: pp.games,
      outs: pp.outs, ip: ipStr,
      er: pp.er, r: pp.r, h: pp.h, hr: pp.hr, bb: pp.bb, k: pp.k,
      pitches: pp.pitches,
      win: pp.win, loss: pp.loss, save: pp.save, hold: pp.hold,
      era: Number(era.toFixed(2)),
      form,
      summary,
    };
  });

  // 並び: 調子レベル降順 → 防御率昇順
  pitchers.sort((a, b) => {
    if (b.form.level !== a.form.level) return b.form.level - a.form.level;
    return a.era - b.era;
  });

  // 今週のMVP / 最も心配な選手 (判定対象＝打数8以上の中から)
  const qualified = players.filter((p) => p.ab >= 8);
  const mvp = qualified.length ? qualified[0] : null;
  const worst = qualified.length ? qualified[qualified.length - 1] : null;

  // 投手MVP / 心配な投手 (判定対象＝投球回3以上＝アウト9以上)
  const qualifiedP = pitchers.filter((p) => p.outs >= 9);
  const pitcherMvp = qualifiedP.length ? qualifiedP[0] : null;
  const pitcherWorst = qualifiedP.length ? qualifiedP[qualifiedP.length - 1] : null;

  const output = {
    generatedAt: new Date().toISOString(),
    baseDate,
    games: argGames,           // 集計対象の試合数（直近N試合）
    rangeStart,                // 実際に集計した最古の試合日
    rangeEnd,                  // 実際に集計した最新の試合日
    foundGames,
    foundPitchingGames,
    mvp: mvp ? { name: mvp.name, summary: mvp.summary, form: mvp.form } : null,
    worst: worst ? { name: worst.name, summary: worst.summary, form: worst.form } : null,
    pitcherMvp: pitcherMvp ? { name: pitcherMvp.name, summary: pitcherMvp.summary, form: pitcherMvp.form } : null,
    pitcherWorst: pitcherWorst ? { name: pitcherWorst.name, summary: pitcherWorst.summary, form: pitcherWorst.form } : null,
    players,
    pitchers,
  };

  if (dry) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const outPath = path.join(GAMES_DIR, 'recent_form.json');
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[recent_form] Wrote ${outPath} (${players.length} batters / ${pitchers.length} pitchers, MVP=${mvp?.name ?? '-'} / 投手MVP=${pitcherMvp?.name ?? '-'})`);
}

main().catch((e) => {
  console.error(`[recent_form] ERROR: ${e.message}`);
  process.exit(1);
});
