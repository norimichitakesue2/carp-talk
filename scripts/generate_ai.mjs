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
    turningPoints: (g.turning_suggestions || []).slice(0, 2).map(t => `${t.inning} ${t.description}`),
    positives: (g.positives || []).filter(p => p.layer === 1).slice(0, 3).map(p => p.title),
    issues: g.team_analysis?.issues || [],
    fanVoice: g.team_analysis?.fan_voice || '',
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

  return `あなたは広島東洋カープを30年見続けてるベテランファンです。
今日の試合の見どころを、直近${pastGames.length}試合の実データをもとに予想してください。
事実から逸脱した内容や創作はNG。直近データに根拠がある予想だけ書いてください。
出力は必ず指定されたJSONフォーマットで、コードブロックや説明文を一切付けず、JSON単体で返してください。

【今日の試合】
${JSON.stringify(todayInfo, null, 2)}

【直近${pastGames.length}試合のサマリ】
${JSON.stringify(pastSummaries, null, 2)}

【出力JSONフォーマット】
{
  "preview": {
    "watchpoints": [
      {
        "title": "<25字以内、見どころのタイトル>",
        "desc": "<80字以内、何を見るべきか・直近データの根拠つき>"
      }
    ],
    "key_players": [
      {
        "name": "<選手名>",
        "role": "投手|打者",
        "reason": "<60字以内、なぜ注目か直近データを根拠に>"
      }
    ],
    "predicted_flow": "<80字以内、序盤・中盤・終盤の試合展開予想>",
    "carp_strength": "<50字以内、今のカープの強み>",
    "carp_weakness": "<50字以内、今の課題>",
    "opponent_threat": "<50字以内、対戦相手の脅威要素>"
  }
}

【ルール】
- watchpoints は 3〜4 個
- key_players は 2〜3 名
- 各項目は直近データ（特定の試合・打席・場面）を根拠にする
- 「だろう」「ありそう」など断定しすぎない口調
- ファン目線で熱量ある書き方（「カープが」「うちが」）
- 創作禁止（直近データに無い選手名・出来事を書かない）
- carpStarter / opStarter が null の場合は先発投手を断定しない
- 直近${pastGames.length}試合とはいえカープ視点で、相手の脅威も含める
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
