// 試合の事実データから Claude API で title_candidates / moments / turning_suggestions / positives を生成
// 使い方:
//   echo "$FACTS_JSON" | node scripts/generate_ai.mjs
//   または
//   cat facts.json | node scripts/generate_ai.mjs

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

if (!ANTHROPIC_API_KEY) {
  console.error('[generate_ai] ANTHROPIC_API_KEY is not set');
  process.exit(1);
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
  const carpIsHome = (tha.home || '').includes('広島') || (tha.home || '').includes('カープ');
  const opponent = carpIsHome ? tha.away : tha.home;
  const lineup = (f?.carpLineup || []).slice(0, 9);
  const opLineup = (f?.opponentLineup || []).slice(0, 9);

  const factsBlob = JSON.stringify({
    date,
    venue: f?.venue,
    status: f?.status,
    teamHomeAway: tha,
    innings,
    pitchers: f?.pitchers,
    homeRuns: f?.homeRuns,
    carpLineup: lineup,
    opponentLineup: opLineup,
  }, null, 2);

  // システムプロンプト：事実厳守、創作禁止、文体はカジュアルなファン視点
  return `あなたは広島東洋カープを愛するベテランファンライターです。
試合の「事実データ」のみが与えられます。事実から逸脱した内容や、データにない選手名・場面を「創作」してはいけません。
出力は必ず指定されたJSONフォーマットで、コードブロックや説明文を一切付けず、JSON単体で返してください。

【今日の試合の事実データ】
${factsBlob}

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
  ]   // 議論を呼ぶ論点を 2〜3個。ファンが本気で意見が割れそうな問いに絞る
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
- 事実データに記載のない選手名・イベントは絶対に創作しない
- 「カープ視点」で書く（「広島が」ではなく「カープが」「うちが」など、ファン目線）
- 完封負け・完封勝ちなどスコアから明らかな出来事はfacts経由で必ず反映
- 同じ表現の繰り返しを避ける
- 過度に攻撃的・断定的な表現（「○○は二軍に落とせ」など）は避け、議論を呼ぶ程度に留める
- moments と turning_suggestions の inning 値は必ず "X回表" または "X回裏" の形式
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

async function main() {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    console.error('[generate_ai] No input on stdin');
    process.exit(1);
  }
  const facts = JSON.parse(stdin);
  const prompt = buildPrompt(facts);

  console.error(`[generate_ai] Calling ${MODEL}...`);
  const raw = await callClaude(prompt);
  const generated = extractJson(raw);

  console.log(JSON.stringify(generated, null, 2));
}

main().catch((e) => {
  console.error(`[generate_ai] ERROR: ${e.message}`);
  process.exit(1);
});
