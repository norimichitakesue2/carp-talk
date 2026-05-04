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

  // nf3 から取得した相手先発の詳細統計（Phase 2）
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
${opPitcherBlock}

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
    "opponent_threat": "<60字以内、対戦相手の脅威要素>"
  }
}

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
- 「だろう」「ありそう」など断定しすぎない口調
- ファン目線で熱量ある書き方（「カープが」「うちが」）
- 創作禁止（直近データに無い選手名・出来事を書かない）
- AIの一般知識による選手評価は最小限に。直近データから引き出せる範囲で
- carpStarter / opStarter が null の場合は先発投手を断定しない
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
