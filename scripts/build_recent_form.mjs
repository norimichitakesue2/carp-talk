// 直近N日のカープ各打者の打撃成績を集計して「調子」を算出する。
// games/YYYY-MM-DD.json の carp_batting フィールドを読んで合算する。
// 出力: games/recent_form.json
//
// 使い方:
//   node scripts/build_recent_form.mjs [基準日 YYYY-MM-DD] [--days N] [--dry]
//   基準日省略時は今日(JST)。--days 省略時は 7。
//
// 調子アイコン (パワプロ風 5段階) は週間OPS換算で判定。
// サンプル(打席数)が少ない場合は「判定不能」にする。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(REPO_ROOT, 'games');

const argDays = (() => {
  const i = process.argv.indexOf('--days');
  if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10) || 7;
  return 7;
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

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 調子判定: 実打率 + 本塁打/打点の小ボーナスで5段階。
// サンプル(打数)が少ない選手のノイズ対策:
//   - 打数8未満は「様子見」（判定不能）
//   - 打数8〜11は極端評価(絶好調/絶不調)を避け、好調/不調どまりにする
function judgeForm(ab, h, hr, rbi) {
  const NONE  = { icon: '－', label: '様子見', level: 0, cls: 'form-none' };
  const HOT2  = { icon: '↑↑', label: '絶好調', level: 2,  cls: 'form-hot2' };
  const HOT1  = { icon: '↑',  label: '好調',   level: 1,  cls: 'form-hot1' };
  const EVEN  = { icon: '→',  label: '普通',   level: 0,  cls: 'form-even' };
  const COLD1 = { icon: '↓',  label: '不調',   level: -1, cls: 'form-cold1' };
  const COLD2 = { icon: '↓↓', label: '絶不調', level: -2, cls: 'form-cold2' };

  if (ab < 8) return NONE;                       // サンプル不足
  const avg = h / ab;
  const bonus = (hr * 0.030) + (rbi * 0.006);    // 長打・打点の小ボーナス
  const score = avg + bonus;
  const small = ab < 12;                         // 8〜11打数は極端評価を避ける

  if (score >= 0.330) return small ? HOT1 : HOT2;
  if (score >= 0.275) return HOT1;
  if (score >= 0.235) return EVEN;
  if (score >= 0.190) return COLD1;
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
  const startDate = addDays(baseDate, -(argDays - 1));
  console.error(`[recent_form] Aggregating ${startDate} 〜 ${baseDate} (${argDays}日間)`);

  // 対象期間の games JSON を読む
  const perPlayer = {};   // name -> {games, ab, r, h, rbi, sb, hr, dates:[]}
  const perPitcher = {};  // name -> {games, outs, er, r, h, hr, bb, k, pitches, win, loss, save, hold}
  let scannedDays = 0;
  let foundGames = 0;
  let foundPitchingGames = 0;

  for (let i = 0; i < argDays; i++) {
    const date = addDays(startDate, i);
    const p = path.join(GAMES_DIR, `${date}.json`);
    let g;
    try { g = JSON.parse(await fs.readFile(p, 'utf8')); }
    catch { continue; }
    scannedDays++;

    // --- 打者集計 ---
    const batting = g.carp_batting;
    if (Array.isArray(batting) && batting.length > 0) {
      foundGames++;
      for (const b of batting) {
        if (!b.name) continue;
        if (!perPlayer[b.name]) {
          perPlayer[b.name] = { name: b.name, games: 0, ab: 0, r: 0, h: 0, rbi: 0, sb: 0, hr: 0, dates: [] };
        }
        const pp = perPlayer[b.name];
        pp.games += 1;
        pp.ab  += b.ab  ?? 0;
        pp.r   += b.r   ?? 0;
        pp.h   += b.h   ?? 0;
        pp.rbi += b.rbi ?? 0;
        pp.sb  += b.sb  ?? 0;
        pp.hr  += b.hr  ?? 0;
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

  console.error(`[recent_form] Scanned ${scannedDays} days, found ${foundGames} batting / ${foundPitchingGames} pitching games`);

  // 各選手の派生指標を計算
  // 打席数 PA は厳密には四死球犠打を含むが、carp_batting には打数しか無いので
  // ここでは「打数」を打席数の近似として扱い、出塁率の代わりに簡易OPSを使う。
  // 簡易OPS = 打率 + 長打率（長打率は単打/二塁/三塁/本塁の内訳が無いので
  //           本塁打のみ4倍, それ以外の安打を1.4倍した粗い近似）。
  const players = Object.values(perPlayer).map((pp) => {
    const ab = pp.ab;
    const avg = ab ? pp.h / ab : 0;
    const form = judgeForm(ab, pp.h, pp.hr, pp.rbi);
    const summary = `直近${pp.games}試合 ${pp.ab}打数${pp.h}安打 ${calcAvg(pp.h, pp.ab)}` +
                    (pp.hr ? ` ${pp.hr}本` : '') +
                    (pp.rbi ? ` ${pp.rbi}打点` : '') +
                    (pp.sb ? ` ${pp.sb}盗塁` : '');
    return {
      name: pp.name,
      games: pp.games,
      ab: pp.ab, r: pp.r, h: pp.h, rbi: pp.rbi, sb: pp.sb, hr: pp.hr,
      avg: calcAvg(pp.h, pp.ab),
      avg_num: Number(avg.toFixed(3)),
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
    days: argDays,
    rangeStart: startDate,
    rangeEnd: baseDate,
    scannedDays,
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
