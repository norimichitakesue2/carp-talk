// 試合の事実データから Claude API で生成:
// - status='final': title_candidates / moments / turning_suggestions / positives / debates / team_analysis
// - status='scheduled': preview（見どころ・キープレイヤー・試合展開予想）
// 使い方:
//   echo "$FACTS_JSON" | node scripts/generate_ai.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAMES_DIR = path.join(REPO_ROOT, 'games');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

if (!ANTHROPIC_API_KEY) {
  console.error('[generate_ai] ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

// playByPlay 配列を AI に読みやすい形式（イニング毎にまとめる）に整形
function formatPlayByPlay(plays, carpIsHome) {
  if (!Array.isArray(plays) || plays.length === 0) return '';
  const carpAttackHalf = carpIsHome ? 'bottom' : 'top';
  const buckets = {};   // inning -> array of formatted lines
  for (const p of plays) {
    if (!buckets[p.inning]) buckets[p.inning] = { half: p.half, items: [] };
    if (p.type === 'pitcher_info') {
      buckets[p.inning].items.push(`  [${p.text}]`);
    } else if (p.type === 'play') {
      const runners = p.runners ? `(${p.runners})` : '';
      // 得点が絡みそうな結果は ★ マーク
      const star = /本塁打|タイムリー|犠牲フライ|押し出し|スクイズ|サヨナラ|ホームイン|失策|エラー/.test(p.result) ? ' ★' : '';
      buckets[p.inning].items.push(`  ${p.outs} ${runners} ${p.batter}: ${p.result}${star}`);
    }
  }
  const orderedInnings = Object.keys(buckets).sort((a, b) => {
    const an = parseInt(a, 10), bn = parseInt(b, 10);
    if (an !== bn) return an - bn;
    return a.includes('表') ? -1 : 1;
  });
  const out = [];
  for (const inn of orderedInnings) {
    const bucket = buckets[inn];
    const isCarpAttack = bucket.half === carpAttackHalf;
    const tag = isCarpAttack ? '【カープ攻撃】' : '【相手攻撃】';
    out.push(`${inn} ${tag}`);
    out.push(...bucket.items);
  }
  return out.join('\n');
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function buildPrompt(facts) {
  const {
    date,
    facts: f,
  } = facts;
  const tha = f?.teamHomeAway || {};
  const innings = f?.innings || [];
  const carpIsHome = !!f?.carpIsHome;
  const lineup = (f?.carpLineup || []).slice(0, 9);
  const opLineup = (f?.opponentLineup || []).slice(0, 9);

  // play-by-play を AI に読みやすい形式にフォーマット
  const playByPlayText = formatPlayByPlay(f?.playByPlay || [], carpIsHome);

  const factsBlob = JSON.stringify({
    date,
    venue: f?.venue,
    status: f?.status,
    lineScore: f?.lineScore,
    pitchers: f?.pitchers,
    homeRuns: f?.homeRuns,
    carpIsHome,
    carpLineup: lineup,
    opponentLineup: opLineup,
  }, null, 2);

  // システムプロンプト：事実厳守、創作禁止、文体はカジュアルなファン視点
  return `あなたは広島東洋カープを愛するベテランファンライターです。
試合の「事実データ」と「一球速報」のみが与えられます。事実から逸脱した内容や、データにない選手名・場面を「創作」してはいけません。
出力は必ず指定されたJSONフォーマットで、コードブロックや説明文を一切付けず、JSON単体で返してください。

【今日の試合の事実データ】
${factsBlob}

【一球速報（全打席結果）】
${playByPlayText || '（一球速報データなし）'}

【出力JSONフォーマット】
{
  "title_candidates": [string × 6],   // ファンが「この試合の本質」と感じうるタイトル候補。30字以内、口語ぽく。勝ち試合は素直に祝福、負け試合は不満から讃辞まで幅広く
  "moments": [
    { "id": 1, "inning": "X回表/裏", "type": "score|defense|hr|crisis|pitcher", "desc": "<25字以内>", "sub": "<60字以内>" }
  ],  // 試合の流れの転換点。スコア変動した回・本塁打・ピンチ脱出を中心に3〜5個
  "turning_suggestions": [
    {
      "inning": "X回表/裏",
      "description": "<60字以内>",
      "reason": "<120字以内>",
      "intensity": "strong|mid|weak",
      "choices": [string × 4]   // ファンが「自分なら〇〇する」を選ぶ4択。多角的な視点で
    }
  ],  // 分岐点候補3〜5個。strong=試合決定的、mid=流れが変わる、weak=注目場面
  "positives": [
    {
      "id": "p_1",
      "layer": 1|2,
      "tag": "小さな光" | "この負けの意味",
      "title": "<25字以内>",
      "desc": "<100字以内>"
    }
  ],  // ポジティブ視点。layer1=試合中の事実ベースの光（3〜4個）、layer2=この試合の長期的な意味（1〜2個）。勝ち試合でも負け試合でも必ず生成
  "debates": [
    {
      "id": "d_1",
      "question": "<30字以内、ファンの間で意見が割れそうな問い>",
      "context": "<60字以内、なぜこの問いが議論になるかの背景>",
      "choices": [
        { "label": "<15字以内、選択肢>", "stance": "<5字以内、立場のラベル例：選手批判/采配批判/相手称賛/容認>" }
      ]
    }
  ],   // 議論を呼ぶ論点を 2〜3個。ファンが本気で意見が割れそうな問いに絞る
  "team_analysis": {
    "issues": ["<課題1、50字以内、データの根拠付きで簡潔に>", "<課題2>", "<課題3>"],
    "improvements": ["<改善案1、50字以内、具体策>", "<改善案2>", "<改善案3>"],
    "fan_voice": "<ファンの本音を100字以内で代弁。情熱・不満・期待を入れて>"
  }
}

【debates のルール】
- 賛否が明確に割れそうな問いに絞る（みんな同じ答えになる問いはNG）
- 例：戦犯論争（誰が悪い？）/ 采配批判（あの選択は正しかった？）/ 選手評価（この選手をどう使う？）/ 試合の意味（この勝ち/負けは流れを変える？）
- 各 debate は 2〜4 個の choice を持つ
- choice は **完全に意見が分かれる** ように設計（例：「持丸が悪い」「采配が悪い」「相手投手を褒めるべき」のように立場が異なる）
- "stance" は短いラベルで、この立場をひと言で表す
- 試合終了後の試合のみ生成（試合前・試合中は debates: [] を返す）
- 全試合で同じ問いを使い回さない。その試合特有の状況に基づくこと

【全体ルール】
- 事実データ・一球速報に記載のない選手名・イベントは絶対に創作しない
- 「カープ視点」で書く（「広島が」ではなく「カープが」「うちが」など、ファン目線）
- 完封負け・完封勝ちなどスコアから明らかな出来事はfacts経由で必ず反映
- 同じ表現の繰り返しを避ける
- 過度に攻撃的・断定的な表現（「○○は二軍に落とせ」など）は避け、議論を呼ぶ程度に留める
- moments と turning_suggestions の inning 値は必ず "X回表" または "X回裏" の形式

【一球速報の活用】
- moments と turning_suggestions は必ず一球速報を根拠にした「具体的な打席や場面」で構成すること（例：「6回裏 二死満塁から持丸が空振り三振」）
- 単に「打線が沈黙」「先発が崩れた」のような抽象表現ではなく、実際にどの打席で何が起きたかを書く
- debates の question / context / choices も具体的な打席ベースで設計すること（例：「6回裏の二死満塁、持丸の三振は誰の責任？」のような）
- 凡退連続やチャンス機逸など、得点が動いていない場面でも重要なら拾うこと（タイムリーを打てなかった場面、四球を活かせなかった場面、など）
`;
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0.4,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text || '';
  return text.trim();
}

function extractJson(text) {
  // ```json ... ``` がついている場合や前後に文字列が付着している場合に備えて頑健に抽出
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in response');
  const json = candidate.slice(start, end + 1);
  return JSON.parse(json);
}

// 直近のカープ試合（final状態）を最大 N 試合読み込む
async function loadPastCarpGames(currentDate, count) {
  const games = [];
  const date = new Date(currentDate);
  let attempts = 0;
  while (games.length < count && attempts < 30) {
    date.setDate(date.getDate() - 1);
    const dateStr = date.toISOString().slice(0, 10);
    const filePath = path.join(GAMES_DIR, dateStr + '.json');
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const game = JSON.parse(data);
      if (game.status === 'final') {
        games.push(game);
      }
    } catch (e) { /* file doesn't exist */ }
    attempts++;
  }
  return games;
}

// 試合のplayByPlayから戦術的に重要な数値パターンを集計
function summarizeGamePatterns(g) {
  const plays = (g.playByPlay || []).filter(p => p.type === 'play');
  const carpHalf = g.away_team === '広島' ? 'top' : 'bottom';
  const carpPlays = plays.filter(p => p.half === carpHalf);
  const opPlays = plays.filter(p => p.half !== carpHalf);

  const isHit = (r) => /安|前|越|線|本塁打|二塁打|三塁打|タイムリー|ホームラン/.test(r || '');
  const isStrikeout = (r) => /三振/.test(r || '');
  const isWalk = (r) => /四球|フォアボール|敬遠|デッドボール|死球/.test(r || '');
  const isScoring = (runners) => /[1-3]塁|満塁/.test(runners || '');

  const tally = (arr) => ({
    total: arr.length,
    hits: arr.filter(p => isHit(p.result)).length,
    strikeouts: arr.filter(p => isStrikeout(p.result)).length,
    walks: arr.filter(p => isWalk(p.result)).length,
  });

  return {
    date: g.game_date,
    carp_total: tally(carpPlays),
    carp_two_out: tally(carpPlays.filter(p => p.outs === '2アウト')),
    carp_with_runners: tally(carpPlays.filter(p => isScoring(p.runners))),
    carp_innings_scored: countScoringInnings(g, carpHalf),
    op_total: tally(opPlays),
    op_two_out: tally(opPlays.filter(p => p.outs === '2アウト')),
    op_innings_scored: countScoringInnings(g, carpHalf === 'top' ? 'bottom' : 'top'),
  };
}

function countScoringInnings(g, half) {
  const innings = (half === 'top' ? g.innings?.away : g.innings?.hiroshima) || [];
  const scoring = [];
  innings.forEach((v, i) => { if (typeof v === 'number' && v > 0) scoring.push(`${i+1}回(${v})`); });
  return scoring;
}

// 試合前プレビュー（見どころ・キープレイヤー・展開予想）の生成プロンプト
function buildPreviewPrompt(facts, pastGames) {
  const f = facts?.facts || {};
  const tha = {
    home: f.gameParts?.homeTeam || (f.carpIsHome ? '広島' : ''),
    away: f.gameParts?.awayTeam || (!f.carpIsHome ? '広島' : ''),
  };
  const opponent = f.carpIsHome ? tha.away : tha.home;
  const pastSummaries = pastGames.map(g => ({
    date: g.game_date,
    opponent: g.away_team === '広島' ? g.home_team : g.away_team,
    venue: g.venue,
    score: `${g.away_team} ${g.away_score ?? '-'}-${g.home_score ?? '-'} ${g.home_team}`,
    result: g.result_label,
    titles: (g.title_candidates || []).slice(0, 3),
    keyMoments: (g.moments || []).slice(0, 4).map(m => `${m.inning} ${m.desc}`),
    turningPoints: (g.turning_suggestions || []).slice(0, 3).map(t => `${t.inning} ${t.description}`),
    positives: (g.positives || []).filter(p => p.layer === 1).slice(0, 3).map(p => p.title),
    issues: g.team_analysis?.issues || [],
    fanVoice: g.team_analysis?.fan_voice || '',
    patterns: summarizeGamePatterns(g),
    // playByPlayの全打席は重いので、得点が動いた回・ピンチ場面・三振場面に絞った要約
    keyPlays: (g.playByPlay || []).filter(p => p.type === 'play' && (
      /本塁打|タイムリー|犠牲フライ|押し出し|サヨナラ|失策|エラー|併殺|三振/.test(p.result || '')
    )).slice(0, 15).map(p => `${p.inning} ${p.outs}${p.runners?'('+p.runners+')':''} ${p.batter}: ${p.result}`),
  }));
  const todayInfo = {
    date: facts.date,
    opponent,
    venue: f.venue,
    carpIsHome: f.carpIsHome,
    carpStarter: f.pitchers?.carpStarter,
    opStarter: f.pitchers?.opStarter,
    carpStarterSource: f.pitchers?.carpStarterSource,
  };

  // 現1軍メンバー（NPB公示）— preview 全体で「使える選手」を縛るための名簿
  const activeRosterList = Array.isArray(f.carpRoster) && f.carpRoster.length > 0
    ? f.carpRoster.map(p => `${p.pos || '?'} ${p.name}`).join(' / ')
    : '（取得失敗）';
  const activeRosterBlock = `

【今日の1軍登録メンバー（NPB公示）— これが今日カープが使える選手の全て】
${activeRosterList}

★ preview の全セクション（watchpoints, key_players, tactical_advice, lineup_proposal 等）で
  「カープ選手」を名前で言及・推奨できるのは【上記の1軍メンバーのみ】。
  過去データ（直近試合・playByPlay 等）に登場しても、この名簿に居なければ抹消・故障で
  今日は出場できない。決して「○○に期待」「○○を起用」のように推さない。
  過去の事実として「△月△日に○○が打った」と回顧的に触れるのは可（ただしその選手を
  今日のキープレイヤーや起用提案には絶対に入れない）。`;

  // nf3 から取得した相手先発の詳細統計（Phase 2 + Phase 3）
  // 数値が無いと AI が一般論に逃げるので、ある時だけ強調して投入する
  const nf3 = f.opponentPitcherNf3;
  let opPitcherBlock = '';
  if (nf3 && nf3.stats) {
    const s = nf3.stats;
    opPitcherBlock = `

【相手先発の詳細統計（nf3.sakura.ne.jp より）】
投手: ${nf3.name}（背番号${nf3.number}, ${s.hand || '?'}, 最終登板${s.lastAppearance || '?'}）
今季成績:
  - 防御率 ${s.era ?? '?'} / WHIP ${s.whip ?? '?'} / QS率 ${s.qsRate ?? '?'}
  - ${s.starts ?? '?'}先発 / ${s.wins ?? '?'}勝${s.losses ?? '?'}敗 / ${s.ip ?? '?'}回 / 投球数${s.pitches ?? '?'} (P/IP ${s.pitchesPerInning ?? '?'})
  - 三振${s.strikeouts ?? '?'} / 四球${s.walks ?? '?'} / 死球${s.hbp ?? '?'} / 被本塁打${s.hrAllowed ?? '?'} / 失点${s.runs ?? '?'} / 自責${s.earnedRuns ?? '?'}
  - 完投${s.completeGames ?? '?'} / 完封${s.shutouts ?? '?'} / 勝率${s.winPct ?? '?'}

この投手の数値から「何を仕掛けるべきか」を必ず1つ tactical_advice に入れること。
（例：QS率が高い → 序盤勝負 / 与四球が多い → 早打ちせず球数稼ぐ / 被本塁打が多い → 一発を狙う / WHIP高い → ランナー貯めれば崩れる など）`;

    // Phase 5: 投手の対右打者/対左打者 成績（左右別成績）
    if (s.vsRightBatter || s.vsLeftBatter) {
      const r = s.vsRightBatter, l = s.vsLeftBatter;
      opPitcherBlock += `

【投手の対打者左右別成績（nf3）】
対右打者: 被打率${r?.avg ?? '?'} (${r?.h ?? 0}-${r?.ab ?? 0}, 本${r?.hr ?? 0}, K${r?.k ?? 0}, 四球${r?.bb ?? 0})
対左打者: 被打率${l?.avg ?? '?'} (${l?.h ?? 0}-${l?.ab ?? 0}, 本${l?.hr ?? 0}, K${l?.k ?? 0}, 四球${l?.bb ?? 0})

→ どちらに弱いかを必ず tactical_advice か patterns.opponent_note で具体的に指摘
（例: 「対右に弱い (.293) → 右打ちのモンテロ・菊池を中軸に積極起用」）`;
    }

    // Phase 6: Yahoo Sportsnavi の球種データ
    if (nf3.yahoo && Array.isArray(nf3.yahoo.pitchTypes) && nf3.yahoo.pitchTypes.length > 0) {
      const lines = nf3.yahoo.pitchTypes.map(p => {
        return `  - ${p.name}: 平均${p.avgSpeed}km/h(最高${p.maxSpeed}) / 全体${p.ratioOverall} 対左${p.ratioVsLeft} 対右${p.ratioVsRight} / K率${p.kRate} 空振${p.whiffRate} 被打${p.avgAgainst}`;
      }).join('\n');
      opPitcherBlock += `

【投手の球種データ（Yahoo Sportsnavi）】
${lines}

→ 必ず以下を活用すること:
  1) key_players の投手 reason に「ストレート平均XXkm/h、決め球はYY (K率Z%)」のように球種特徴を具体的に書く
  2) tactical_advice の1つに「対左で多投する球種は○○ (XX%) → 左打者は△△を意識」など球種別対策を入れる
  3) 被打率が高い球種があれば「××は被打率.XXX、当たれば長打」と打者へのヒント
  4) 創作禁止 — このリストに無い球種は書かない`;
    }

    opPitcherBlock += `

【球種・投手タイプの記述（追加知識）】
あなたが ${nf3.name} の投球スタイルや個性を高い確度で知っている場合（フォーム、配球パターン、性格、勝負強さなど）、
key_players の reason の中で言及してOK。ただし球種・球速の数値は上の Yahoo データから引用すること（創作禁止）。`;

    // Phase 4: カープ打者の通算 + 対右/対左 成績（refresh_carp_batters.mjs が生成）
    // 相手投手の利き腕に対応する成績を強調する
    if (Array.isArray(f.carpBatters) && f.carpBatters.length > 0) {
      // 相手投手の利き腕を判定 (右投/左投)
      const isOpRightHanded = /^右投/.test(s.hand || '');
      const isOpLeftHanded  = /^左投/.test(s.hand || '');
      const splitLabel = isOpRightHanded ? '対右投手' : isOpLeftHanded ? '対左投手' : '対右投手';
      const splitKey   = isOpRightHanded ? 'vsRight'  : isOpLeftHanded ? 'vsLeft'   : 'vsRight';

      // 1軍抹消選手をフィルタ: 当日のNPB公示（carpRoster）に居る選手のみAIに渡す
      // nf3 はフルネーム ("小園海斗")、NPB は苗字 ("小園") が多いので苗字一致も許容
      const activeRoster = Array.isArray(f.carpRoster) && f.carpRoster.length > 0
        ? f.carpRoster.map(p => p.name).filter(Boolean)
        : null;
      const isActive = (nf3Name) => {
        if (!activeRoster) return true;  // 公示データ無ければフィルタしない（保険）
        if (!nf3Name) return false;
        return activeRoster.some(rn => rn === nf3Name || nf3Name.startsWith(rn) || rn.startsWith(nf3Name));
      };
      const filtered = f.carpBatters.filter(b => isActive(b.name));
      const excluded = f.carpBatters.length - filtered.length;
      if (excluded > 0) {
        console.error(`[ai] Filtered out ${excluded} non-active batters from preview prompt`);
      }

      // 通算成績を打席数で並べて出す（出場機会少ない選手は後ろに）
      const batters = [...filtered].sort((a, b) => (b.career?.pa ?? 0) - (a.career?.pa ?? 0));
      const lines = batters.slice(0, 16).map(b => {
        const c = b.career || {};
        const sp = b[splitKey] || {};
        const splitText = sp.avg
          ? `${splitLabel}.${(sp.avg+'').replace(/^\./,'')}（${sp.h ?? 0}-${sp.ab ?? 0}, 本${sp.hr ?? 0}, K${sp.k ?? 0}）`
          : `${splitLabel}データなし`;
        return `  - ${b.name}(${b.hand || '?'}): 通算${c.avg || '?'} OPS${c.ops || '?'} 本${c.hr ?? 0} | ${splitText}`;
      }).join('\n');

      opPitcherBlock += `

【カープ打者の対左右別成績（相手投手は ${s.hand || '?'} ${nf3.name}）】
${lines}

これを以下に必ず活用すること:
  1) tactical_advice の1つに「${splitLabel}で打率高い○○を中軸に / 苦手な××は下位 or スタメン外」など起用提案
  2) key_players に ${splitLabel} 成績の良い／悪い注目選手を入れる
  3) 今季サンプル少ない（打席数<10）場合は通算側を参考にし「サンプル少ないが」と前置く`;
    }

    // Phase 3: 対カープ打者 通算成績
    if (Array.isArray(nf3.vsCarp) && nf3.vsCarp.length > 0) {
      // 1軍抹消選手をフィルタ（Phase 4 と同じロジック）
      const activeRosterP3 = Array.isArray(f.carpRoster) && f.carpRoster.length > 0
        ? f.carpRoster.map(p => p.name).filter(Boolean)
        : null;
      const isActiveP3 = (nf3Name) => {
        if (!activeRosterP3) return true;
        if (!nf3Name) return false;
        return activeRosterP3.some(rn => rn === nf3Name || nf3Name.startsWith(rn) || rn.startsWith(nf3Name));
      };
      // 打席数で並べて全選手 AI に渡す（サンプル数の重みづけは AI 判断に任せる）
      // シーズン序盤はサンプル少ない人だらけになるので、最低1打席で許容
      const meaningful = nf3.vsCarp.filter(b => isActiveP3(b.name) && (b.pa ?? 0) >= 1);
      meaningful.sort((a, b) => (b.pa ?? 0) - (a.pa ?? 0));
      const top = meaningful.slice(0, 16);
      if (top.length > 0) {
        const lines = top.map(b => {
          const avg = b.avg || '.000';
          const ops = (b.h != null && b.ab != null && b.ab > 0) ? `(${b.h}-${b.ab})` : '';
          return `  - ${b.name}: 通算${b.pa}打席 打率${avg} ${ops} / 本${b.hr ?? 0} 三振${b.k ?? 0} 四球${b.bb ?? 0}`;
        }).join('\n');
        opPitcherBlock += `

【カープ打者 vs ${nf3.name} 通算成績】
(打席数3以上の打者のみ、打席数順)
${lines}

この相性データを必ず以下に活用すること:
  1) tactical_advice の1つに「相性の悪い打者を○○で起用」「打率高い打者を中軸に」など具体的に
  2) key_matchups に3〜6人ピックアップして所感を付ける（相性○な打者と×な打者を両方入れる）
  3) 通算0安打 (0-X) の選手や被本塁打のある選手は特に強調
  4) サンプル数(打席数)が少ない (1〜3打席) 場合は「サンプル少ないが」と前置きするか、判断を保留する
  5) シーズン初対戦で全員サンプル0〜1打席 の場合は key_matchups は空配列にして良い`;
      }
    }
  }

  // Phase 8a + 深掘り: 相手先発との「今季全対戦」集計 + nf3 通算 vsカープ を統合
  let matchupBlock = '';
  const sm = f.seasonMatchups;
  const nf3VsCarp = (nf3 && Array.isArray(nf3.vsCarp)) ? nf3.vsCarp : [];
  if (sm && sm.count > 0) {
    const tt = sm.teamTotals;
    // 各試合の1行サマリ（新しい順、最大5試合）
    const gamesText = sm.games.slice(0, 5).map(gm =>
      `  ${gm.date} @${gm.venue || '?'}: カープ${gm.carpScore}-${gm.opScore}（${gm.result || '?'}）`
    ).join('\n');
    // 今季この投手と対戦したカープ打者の合算（打数順、上位12）
    const battersText = sm.batters.slice(0, 12).map(b =>
      `  ${b.name}: 今季${b.ab}打数${b.h}安打 .${(b.avg||'.000').replace(/^\./,'')}` +
      (b.hr ? ` ${b.hr}本` : '') + (b.rbi ? ` ${b.rbi}打点` : '') +
      (b.k ? ` ${b.k}三振` : '') + (b.bb ? ` ${b.bb}四球` : '')
    ).join('\n');
    // nf3 の通算 vsカープ（今季データに無い相性傾向の補完）
    const nf3Text = nf3VsCarp.length
      ? nf3VsCarp.filter(b => (b.pa ?? 0) >= 1).slice(0, 12).map(b =>
          `  ${b.name}: 通算${b.pa}打席 打率${b.avg || '.000'}` +
          (b.hr ? ` ${b.hr}本` : '') + (b.k ? ` ${b.k}三振` : '')
        ).join('\n')
      : '  （nf3通算データなし）';
    matchupBlock = `

【相手先発との今季カープ対戦（自軍アーカイブ集計）】
今季 ${tt.games}試合対戦 / カープ ${tt.carpWins}勝${tt.games - tt.carpWins}敗
チーム通算: ${tt.ab}打数${tt.h}安打 打率${tt.avg} / ${tt.hr}本 ${tt.double}二塁打 ${tt.rbi}打点 ${tt.k}三振 ${tt.bb}四球
各試合:
${gamesText}

【今季この投手と対戦したカープ打者の合算成績】
${battersText}

【参考: nf3 通算 vsカープ成績（今季以前も含む）】
${nf3Text}

これを必ず以下に活用すること:
  1) last_matchup フィールドに「今季この投手にどう抑えられている/打てているか」を書く。
     必ず数字を引用（「今季3試合で通算${tt.ab}打数${tt.h}安打.${(tt.avg||'.000').replace(/^\./,'')}、${tt.k}三振」など）。
  2) やられている場合（チーム打率が低い・三振が多い等）は具体的な対策を countermeasure に書く。
  3) 打者別データで「特に苦手な打者」「逆に打てている打者」が居れば summary で名指しする
     （「小園は今季0-8と完全に抑え込まれている」「坂倉は.333と相性良し」など）。
  4) is_first は false にする。`;
  } else {
    // 今季対戦なし — nf3 通算データだけでも触れる
    const nf3Text = nf3VsCarp.length
      ? nf3VsCarp.filter(b => (b.pa ?? 0) >= 2).slice(0, 10).map(b =>
          `  ${b.name}: 通算${b.pa}打席 打率${b.avg || '.000'}` + (b.hr ? ` ${b.hr}本` : '') + (b.k ? ` ${b.k}三振` : '')
        ).join('\n')
      : '';
    matchupBlock = `

【相手先発との今季カープ対戦】
今季の対戦記録なし（今季初対戦、または対戦データ未蓄積）。
${nf3Text ? `\n【参考: nf3 通算 vsカープ成績】\n${nf3Text}\n` : ''}
→ last_matchup フィールドは is_first: true として「今季初対戦」と書く。
  nf3 通算データがあれば「通算では○○が苦手」など相性傾向に触れてよい。
  countermeasure は通算データから言えることがあれば書く、無ければ空文字。`;
  }

  // Phase 8b: 直近の打順 + 選手の調子（打順提案用）
  let lineupBlock = '';
  const recentLineups = f.recentLineups || [];
  const rfPlayersRaw = f.recentForm?.players || [];
  if (recentLineups.length > 0) {
    // 当日の carpRoster (現在の1軍公示) で抹消選手を除外
    // recent_form は直近6試合の選手なので、その間に抹消された選手も含まれる
    const activeNames = Array.isArray(f.carpRoster) && f.carpRoster.length > 0
      ? f.carpRoster.map(p => p.name).filter(Boolean)
      : null;
    const isActive = (name) => {
      if (!activeNames) return true;   // 公示データ無ければ素通し
      if (!name) return false;
      return activeNames.some(rn => rn === name || name.startsWith(rn) || rn.startsWith(name));
    };
    const rfPlayers = rfPlayersRaw.filter(p => isActive(p.name));
    const excludedFromForm = rfPlayersRaw.length - rfPlayers.length;
    if (excludedFromForm > 0) {
      console.error(`[ai] lineup_proposal: filtered out ${excludedFromForm} non-active players (抹消選手) from form data`);
    }

    const lineupText = recentLineups.map(l =>
      `  ${l.date}: ` + l.order.map(o => `${o.line}番${o.name}(${o.pos})`).join(' / ')
    ).join('\n');

    // 直近スタメン選手の名前セット（控え判定用）— 抹消含む historical fact
    // ただし提案には使わない（提案は rfPlayers＝アクティブのみから選ばせる）
    const starterNames = new Set();
    recentLineups.forEach(l => l.order.forEach(o => o.name && starterNames.add(o.name)));
    const isStarterName = (name) => {
      if (!name) return false;
      for (const sn of starterNames) {
        if (sn === name || name.startsWith(sn) || sn.startsWith(name)) return true;
      }
      return false;
    };

    // nf3 の vsカープ通算成績を名前で引けるように（控えの相性チェック用）
    const vsCarpByName = {};
    if (nf3 && Array.isArray(nf3.vsCarp)) {
      nf3.vsCarp.forEach(b => { if (b.name) vsCarpByName[b.name] = b; });
    }
    const findVsCarp = (name) => {
      if (vsCarpByName[name]) return vsCarpByName[name];
      for (const k of Object.keys(vsCarpByName)) {
        if (k.startsWith(name) || name.startsWith(k)) return vsCarpByName[k];
      }
      return null;
    };

    // スタメン組と控え組に分ける
    const starterForm = rfPlayers.filter(p => isStarterName(p.name));
    const benchForm   = rfPlayers.filter(p => !isStarterName(p.name));

    // 名前→守備位置 マップ
    // 優先順: 直近試合の実戦守備位置（細かい：一/二/三/遊/左/中/右/捕）
    //         → fallback: carpRoster の大分類（捕/内/外/投）
    // 直近実戦の方が「実際にその選手がどこを守るか」を正確に表す
    const detailedPosByName = {};
    // 古い試合から順に処理 → 最新試合の pos が最終的に上書きされる
    [...recentLineups].reverse().forEach(l => {
      l.order.forEach(o => {
        if (o.name && o.pos) detailedPosByName[o.name] = o.pos;
      });
    });
    const rosterPosByName = {};
    if (Array.isArray(f.carpRoster)) {
      f.carpRoster.forEach(rp => { if (rp.name) rosterPosByName[rp.name] = rp.pos || '?'; });
    }
    const findPos = (name) => {
      // 完全一致 or 部分一致で実戦守備位置を引く（複数登録の柔軟マッチ）
      const tryMap = (m) => {
        if (m[name]) return m[name];
        for (const k of Object.keys(m)) {
          if (k === name || k.startsWith(name) || name.startsWith(k)) return m[k];
        }
        return null;
      };
      return tryMap(detailedPosByName) || tryMap(rosterPosByName) || '?';
    };
    const fmtForm = (p) => {
      const vc = findVsCarp(p.name);
      const vcText = vc ? ` | 対${nf3?.name || '相手'}通算 ${vc.h ?? 0}-${vc.ab ?? 0}(.${(vc.avg||'.000').replace(/^\./,'')})` : '';
      // 実戦ポジ(細かい) と 登録ポジ(大分類) を併記。柔軟性が伝わる
      // 例: 二俣(右/内) = 実戦は右翼、登録は内野 → 内野でも守れる
      const playPos = (() => {
        const tryMap = (m) => {
          if (m[p.name]) return m[p.name];
          for (const k of Object.keys(m)) {
            if (k === p.name || k.startsWith(p.name) || p.name.startsWith(k)) return m[k];
          }
          return null;
        };
        return tryMap(detailedPosByName);
      })();
      const regPos = (() => {
        const tryMap = (m) => {
          if (m[p.name]) return m[p.name];
          for (const k of Object.keys(m)) {
            if (k === p.name || k.startsWith(p.name) || p.name.startsWith(k)) return m[k];
          }
          return null;
        };
        return tryMap(rosterPosByName);
      })();
      let posDisplay = playPos || regPos || '?';
      if (playPos && regPos && !regPos.includes(playPos.charAt(0))) {
        // 実戦と登録が違う系統なら両方表示（例：右/内）
        posDisplay = `${playPos}/${regPos}`;
      }
      return `  ${p.name}(${posDisplay}): ${p.form?.label || '?'} | OPS${p.ops || '?'} 出塁${p.obp || '?'} 長打${p.slg || '?'} 打率${p.avg || '?'} | ${p.hr || 0}本 ${p.rbi || 0}打点 ${p.bb || 0}四球 ${p.k || 0}三振${vcText}`;
    };
    const formText = starterForm.map(fmtForm).join('\n');
    const benchText = benchForm.length
      ? benchForm.map(fmtForm).join('\n')
      : '  （該当なし）';

    // 最新試合の打順だけ別途明示（AIが古い試合の打順を引きずる対策）
    const latest = recentLineups[0];   // recentLineups は新しい順
    const latestLineupText = latest
      ? '  ' + latest.order.map(o => `${o.line}番${o.name}(${o.pos})`).join(' / ')
      : '（データなし）';

    lineupBlock = `

★★【最新試合(${latest?.date || '?'})の打順 — これが基準】★★
${latestLineupText}
※ この最新試合の打順が「基準打順」。これをそのままコピーして書き出してから
  入れ替えだけ行うこと。古い試合の打順を引きずるのは禁止。

【直近3試合の打順（参考）】※ 抹消・故障の選手も含まれる
${lineupText}

【スタメン組の調子（直近6試合）】※ ここに居る選手＝現1軍登録のみ
${formText || '  （調子データなし）'}

【控え組の調子（直近スタメンに居ない現1軍選手）】
${benchText}

★【絶対厳守①】lineup_proposal の order に書ける選手は、上の
【スタメン組の調子】【控え組の調子】に列挙されている選手【だけ】。
直近の打順に出てくるが【調子リスト】に居ない選手（＝抹消・故障で1軍離脱）は
絶対に提案に含めないこと。

★【絶対厳守②】基準打順は「最新試合(${latest?.date || '?'})の打順」のみ。
それより古い試合の打順は参考程度。最新試合に居なかった選手を
「直近2試合は2番だった」等の理由で提案に入れるのは禁止。

★【絶対厳守③】守備位置の整合性チェック:
  - 各選手の括弧内 pos の見方:
    - 「右」「二」など1文字 = 直近実戦の細かい守備位置
    - 「右/内」のようなスラッシュ表記 = 実戦は前者、登録は後者の系統 → 柔軟に動ける
    - 「内」「外」「捕」のみ = 大分類しか分からない（実戦記録なし）
  - 8人の野手で 捕・一・二・三・遊・左・中・右 を必ず網羅。重複禁止。
  - 同じ細かい守備位置に2人禁止:
    × 菊池(二) と 勝田(二) を両方入れる
    × 野間(右) と 二俣(右) を両方入れる ← 1文字目「右」が同じ
  - 柔軟プレイヤーは別位置にスライドさせる:
    例：野間(右) を入れたいが二俣(右) も中軸に入れたい場合
        → 二俣(右/内) は内野もできるので、別の控え内野手と入れ替えて
          二俣を内野守備に回す案を出してもよい
        → ただし複雑な兼任は避け、被りが解消できないなら
          【入れ替えそのものを諦めて最新打順維持】が正解
  - 入れ替え提案する前に必ず守備配置を頭の中で組み立て、
    8人全員の守備位置が重複なく決まることを確認してから order を出力する。

lineup_proposal は以下の【手順】を順番通りに実行して組み立てること。
手順を飛ばしたり、独自判断で「最適化」してはいけない。

【打順提案の手順 — この順番で機械的に実行】

STEP 0. 直近3試合の打順から「直近の基準打順」を決める（最新試合の打順を基準にする）。
        この基準打順を配列としてコピーする。これが出発点。

STEP 1. 各選手に調子ラベル（絶好調/好調/普通/不調/絶不調/様子見）を割り当てる。

STEP 2. 「動かす対象」を特定する。動かす対象は次の2種類だけ:
        (A) 絶不調・不調 なのに 中軸(3〜4番) または 上位(1〜2番) に居る選手 → 降格対象
        (B) 絶好調・好調 なのに 下位(6〜8番) に埋もれている選手 → 昇格対象
        ※ これ以外の選手は「動かさない」。特に:
           - 好調以上で既に1〜5番に居る選手は【絶対に動かさない】（聖域）。
             4番で好調の選手を「3番の方が役割に合う」等の理由で動かすのは厳禁。
           - 普通・様子見の選手も、降格/昇格対象に押し出されない限り動かさない。
        ※【厳守】降格対象(A)は原則すべて中軸/上位から外す。
           「モンテロは下げたが小園は3番に放置」のような不整合・曖昧な理由はダメ。
           ただし好調者不在で中軸が埋まらない場合は STEP 4.5 の手順に従い、
           最も妥当な選手を明確な理由付きで中軸に残してよい（曖昧な放置だけが禁止）。

STEP 3. 降格対象(A)を下位(6〜8番)へ移す。空いた枠を「空き枠」として記録。

STEP 4. 【最優先】昇格対象(B)＝自軍の好調以上の選手を空き枠へ。
        昇格対象(B)を、STEP3で空いた枠 or 「普通・様子見の選手が居る枠」へ入れる。
        ※ 控え選手の起用より「自軍スタメンの好調選手の昇格」を必ず優先する。
          絶好調の選手が6番に居るなら、まずその選手を中軸へ上げる（控え検討より先）。
        【厳守】好調以上の選手が居る枠には絶対に入れない（玉突きで追い出さない）。
        入れる枠を選ぶ時、複数候補があれば選手特性に合う方を選ぶ:
          - 高出塁・俊足型 → なるべく1〜2番側
          - 長打型 → なるべく4〜5番側
        押し出された普通・様子見の選手は、空いている枠へスライド。

STEP 4.5. 【中軸の空き枠を埋める】STEP4の後でも中軸(3〜5番)に空きが残り、
        好調以上の選手で埋まらない場合（チーム全体が不調なケース）:
          - 普通・様子見の選手、または相手投手と相性の良い選手を中軸に置く。
          - その選手が本調子でない/絶不調でも「相手投手に通算◎」なら起用してよい。
          - note には「他に適任者がおらず、○番にせざるを得ない」と正直に書く。
            妥協・苦肉の策であることを率直に明示するトーンにする。
            （例：「好調者不在で、大竹に通算.500と相性の良い小園を3番にせざるを得ない。
              本調子ではないが現状ベストの選択」）
          - 絶対NG：絶不調の選手を「絶不調だが維持」と曖昧な理由で中軸に放置すること。
            置くなら「せざるを得ない」理由（相性・消去法）を明確に述べる。

STEP 4.7. 【控え選手のスタメン起用提案】※めったに発動しない最終手段。
        次の【すべて】を満たす時だけ、控え選手1人のスタメン起用を提案してよい:
          条件1: その控え選手が「絶好調」である（打数8以上の確かなサンプル必須）。
                 ※「好調」「普通」「相性が良いだけ」では発動しない。絶好調のみ。
          条件2: スタメンに「絶不調」の選手が居て、その選手と同じ守備系統で
                 控え選手が代われる。
        上記を満たす場合のみ:
          → その絶不調スタメンを外し、控え選手をその打順あたりに起用提案。
          → note に「控えだが直近絶好調(OPS.xxx)のためスタメン提案」と明示。
        ※【厳守】自軍スタメンの好調選手の昇格(STEP4)を必ず優先する。
          絶好調の控えが居ても、自軍スタメンの好調選手で空き枠が埋まる分には
          控えを無理に入れない。控え起用は「絶好調の控え＋絶不調のスタメン」が
          明確に並存する時の最終調整に限る。
        ※ 条件を満たさなければ何もしない（控えを入れない）。
          単に相手投手と相性が良いだけの控えは提案しない。

STEP 5. 残った全選手は基準打順の位置のまま。1〜8番を埋めて order 配列にする。

【各 note の書き方】
- 動かした選手: なぜ動かしたかを調子の数値で書く
  （「絶不調OPS.467のため中軸から7番へ降格」「絶好調OPS.981、長打型なので4番付近へ」）
- 動かさなかった選手: 「直近の打順を維持」と簡潔に。好調なら「好調OPS.xxxで○番継続」
- 役割にハマる選手が居ない枠は正直に「適任者不在、消去法で配置」と書く（嘘の理由を作らない）

【各打順の役割（昇格先を選ぶ時の参考。既存選手の配置換え理由には使わない）】
- 1〜2番: 出塁率・三振の少なさ重視  / 3番: OPS総合力  / 4〜5番: 長打率・打点重視

【その他】
- 1〜8番（野手）の order を出力。投手の打順は省略。
- intro は「何を変えたか」を一言で。note(全体) は「あくまで一案」のトーン。
- 変更が0〜1箇所でも構わない。チームが好調者だらけ/不調者だらけなら無理に動かさない。`;
  }

  // Phase 8c: ファーム（2軍）からのコールアップ提案
  // チームの「課題」を埋められそうな2軍選手にフォーカスする（単に打ちまくる選手ではない）
  let farmBlock = '';
  const farm = f.farmStats;
  if (farm && (farm.batters?.length || farm.pitchers?.length)) {
    const batText = (farm.batters || []).map(b =>
      `  ${b.name}: 打率${b.avg || '?'} OPS${b.ops || '?'}（出塁${b.obp || '?'}/長打${b.slg || '?'}） ` +
      `${b.games || 0}試合 ${b.hr || 0}本 ${b.double || 0}二塁打 ${b.rbi || 0}打点 ${b.sb || 0}盗塁 ${b.bb || 0}四球 ${b.k || 0}三振`
    ).join('\n') || '  （該当なし）';
    const pitText = (farm.pitchers || []).map(p =>
      `  ${p.name}: 防御率${p.era || '?'} ${p.games || 0}登板 ${p.ip || '?'}回 ` +
      `${p.wins || 0}勝${p.losses || 0}敗${p.saves || 0}S 奪三振${p.strikeouts || 0} 与四球${p.walks || 0} 被本${p.hrAllowed || 0}`
    ).join('\n') || '  （該当なし）';
    farmBlock = `

【カープ2軍（ファーム）の主な選手成績（NPB公式・規定到達者）】
野手:
${batText}
投手:
${pitText}

farm_callup フィールドを次の方針で組み立てること:
  1) まず「今の1軍カープの課題」を1つ特定する。
     課題は preview の carp_weakness や、選手の調子データ・直近試合の傾向から導く。
     例：「中軸の長打力不足」「上位打線の出塁率の低さ」「右の長距離砲が居ない」
        「左投手に弱い」「終盤を任せられる救援不足」など。
  2) その課題を【埋められそうな】2軍選手を1〜2人ピックする。
     ★重要：単に「打ちまくっている選手」を選ぶのではない。
       課題とのマッチングを最優先する。
       - 課題が長打不足 → 2軍で二塁打/本塁打が多い選手
       - 課題が出塁率 → 2軍で出塁率・四球が多い選手
       - 課題が救援 → 2軍で防御率が良く奪三振の多い投手
       - 課題が先発 → 2軍で長いイニング投げて防御率が良い投手
  3) 各候補に「なぜこの課題を埋められるか」を2軍成績の数字で必ず根拠づける。
  4) 該当する選手が居ない、または2軍データが乏しい場合は farm_callup を null にする。
  5) これは「ファン目線のIF提案」。現実の起用を断定しない。
     「2軍で○○な××を試してみては」というトーン。`;
  }

  return `あなたは広島東洋カープを30年見続けてる、戦術にも詳しいベテランファンです。
今日の試合の「ニッチで具体的な見どころ」を、直近${pastGames.length}試合の実データをもとに予想してください。

【最重要：単なる感想ではなく、戦術的・統計的なインサイトを出すこと】
- "patterns" の数値（二死での成績、得点圏成績、得失点イニング等）を読み取って傾向を抽出
- "keyPlays" の打席結果から失敗/成功パターンを見つける
- 「直近X試合中Y試合で○○が起きている」のような数値根拠で語る
- 一般論（「打線が大事」など）ではなく、このカープ固有の傾向に基づく具体策

事実から逸脱した内容や創作はNG。直近データに無い選手名・成績は絶対に書かない。
出力は必ず指定されたJSONフォーマットで、コードブロックや説明文を一切付けず、JSON単体で返してください。

【今日の試合】
${JSON.stringify(todayInfo, null, 2)}
${activeRosterBlock}
${opPitcherBlock}
${matchupBlock}
${lineupBlock}
${farmBlock}

【直近${pastGames.length}試合のサマリ＋数値パターン】
${JSON.stringify(pastSummaries, null, 2)}

【出力JSONフォーマット】
{
  "preview": {
    "watchpoints": [
      {
        "title": "<25字以内、見どころのタイトル>",
        "desc": "<100字以内、何を見るべきか。必ず直近データの数値や具体場面を根拠に挙げる>"
      }
    ],
    "key_players": [
      {
        "name": "<選手名（直近データに登場した選手のみ）>",
        "role": "投手|打者",
        "reason": "<80字以内、なぜ注目か直近の具体的な打席・登板を根拠に>"
      }
    ],
    "tactical_advice": [
      {
        "title": "<25字以内、戦術提案のタイトル>",
        "desc": "<100字以内、なぜこの戦術が良いか直近データの根拠つき。例：「直近5試合で4回までに先制した試合は2勝0敗、4回までに失点した試合は0勝3敗。序盤の援護が鍵」>"
      }
    ],
    "patterns": {
      "carp_trend": "<80字以内、カープが直近で陥っている/脱しつつあるパターン。具体数値で>",
      "opponent_note": "<80字以内、対戦相手の傾向・カープが付け入る隙。直近対戦データがあれば言及>"
    },
    "predicted_flow": "<100字以内、序盤・中盤・終盤の試合展開予想。具体数値根拠で>",
    "carp_strength": "<60字以内、今のカープの強み。直近データの数値で>",
    "carp_weakness": "<60字以内、今の課題。直近データの数値で>",
    "opponent_threat": "<60字以内、対戦相手の脅威要素>",
    "key_matchups": [
      {
        "batter": "<カープ打者名（vsCarp データに居る選手のみ）>",
        "stat": "<例：通算12-3 .250 (本1)>",
        "verdict": "<相性 'good' | 'bad' | 'even' のどれか>",
        "note": "<60字以内、相性所感。例：'三振率高め、初球からファール狙い'>"
      }
    ],
    "last_matchup": {
      "is_first": <前回対戦データが無ければ true、あれば false>,
      "summary": "<前回対戦の振り返り。日付・スコア・チーム成績を引用。100字以内。is_first:true なら『今季初対戦』と書く>",
      "countermeasure": "<前回やられていた場合の対策、打てていた場合は継続方針。80字以内。is_first:true なら空文字でよい>"
    },
    "lineup_proposal": {
      "intro": "<40字以内、提案の主旨。例：'絶好調の持丸を2番に上げる組み替え案'>",
      "order": [
        { "line": 1, "name": "<選手名>", "note": "<30字以内、起用理由。直近の打順から変えた箇所のみ理由必須>" }
      ],
      "note": "<60字以内、全体の狙い・補足。「あくまで一案」のトーンで>"
    },
    "farm_callup": {
      "issue": "<40字以内、今の1軍の課題。例：'中軸の長打力不足'>",
      "candidates": [
        {
          "name": "<2軍選手名（farmデータに居る選手のみ）>",
          "role": "野手|投手",
          "stat": "<例：2軍で打率.298 OPS.850 二塁打10>",
          "reason": "<60字以内、なぜこの課題を埋められるか。2軍成績の数字を根拠に>"
        }
      ],
      "note": "<50字以内、補足。「ファン目線のIF提案」のトーンで>"
    }
  }
}

【farm_callup のルール】
- 上の【カープ2軍の主な選手成績】を必ず使う。データに無い選手は書かない。
- candidates は1〜2人。課題を埋められる選手が居なければ farm_callup 全体を null。
- 「打ちまくってる選手」ではなく「課題を埋める選手」を選ぶ（最重要）。
- 2軍データブロックが入力に無い場合は farm_callup を null にする。

【last_matchup / lineup_proposal のルール】
- last_matchup: 上の【相手先発との前回カープ対戦】ブロックの数字を必ず引用。創作禁止。
- lineup_proposal: 上の【直近の打順】【選手の調子】ブロックを必ず使う。
  - order は1〜8番（野手）。直近の打順をベースに2〜3箇所の入れ替えに留める。
  - データ（直近の打順・調子）が無い場合は lineup_proposal を null にする。
  - 直近データ・調子データに居ない選手名は絶対に書かない。

【インサイト抽出のヒント】
- carp_two_out（二死からの結果）：得点を取れる/取れない傾向
- carp_with_runners（得点圏での結果）：チャンスでの集中力
- carp_innings_scored / op_innings_scored：得点が動く回パターン
- keyPlays（重要打席）：併殺・三振が多いカウント、本塁打を打たれた状況
- 連敗/連勝中なら、その共通項を探る
- 直近試合の opponent と今日の opponent が同じなら、対戦相性を強く意識

【ルール】
- watchpoints は 3〜4 個（具体性最優先）
- key_players は 2〜3 名（直近データに名前が出てきた選手限定）
- tactical_advice は 2〜3 個（攻撃方針・継投・采配の具体提案）
- key_matchups は 4〜6 名（vsCarp データがある時のみ。無ければ空配列）
- 「だろう」「ありそう」など断定しすぎない口調
- ファン目線で熱量ある書き方（「カープが」「うちが」）
- 創作禁止（直近データ・vsCarp データに無い選手名・成績を書かない）
- AIの一般知識による選手評価は最小限に。直近データから引き出せる範囲で
- carpStarter / opStarter が null の場合は先発投手を断定しない

【最重要：選手起用提案で必ず守ること】
- 言及・推奨してよいのは「直近5試合のサマリ」「カープ打者vs左/右成績」「対カープ打者通算」のいずれかに登場した選手のみ
- 上記データに含まれていない選手（1軍抹消・出場機会なし）は絶対に名前を出さない
- 直近試合で出場している選手 = 現在の1軍メンバー、と判断する
- 「○○を中軸に」「○○を外す」のような起用提案は、直近試合で実際に出場した選手名のみに対して行う
`;
}

async function main() {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    console.error('[generate_ai] No input on stdin');
    process.exit(1);
  }
  const facts = JSON.parse(stdin);
  const status = facts.facts?.status;

  let prompt;
  if (status === 'final') {
    prompt = buildPrompt(facts);
  } else if (status === 'scheduled' || status === 'live') {
    // プレビュー生成：直近のカープ試合データを読む
    const pastGames = await loadPastCarpGames(facts.date, 5);
    if (pastGames.length === 0) {
      console.error('[generate_ai] No past games available for preview, skipping AI');
      console.log('{}');
      return;
    }
    prompt = buildPreviewPrompt(facts, pastGames);
  } else {
    console.error(`[generate_ai] Status "${status}" — skipping AI`);
    console.log('{}');
    return;
  }

  console.error(`[generate_ai] Calling ${MODEL} (status=${status})...`);
  const raw = await callClaude(prompt);
  const generated = extractJson(raw);

  console.log(JSON.stringify(generated, null, 2));
}

main().catch((e) => {
  console.error(`[generate_ai] ERROR: ${e.message}`);
  process.exit(1);
});
