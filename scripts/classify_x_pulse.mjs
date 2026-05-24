// Xから取得したカープ関連ツイートを Haiku で2パス分類し、バブルチャート用JSONを生成。
//
// パス1（per ツイート）: targetType / target / topic_broad / sentiment を分類
//   20件ずつバッチで Haiku に投げて効率化。
// パス2（per クラスタ）: (target × topic_broad × sentiment) クラスタの
//   ツイート群をまとめて Haiku に再投入し、1-3語の具体ラベルを得る。
//
// 使い方:
//   node scripts/classify_x_pulse.mjs --input <tweets.json> --output <bubbles.json>
//   node scripts/classify_x_pulse.mjs --input <tweets.json> --dry  # 標準出力にdump
//
// 入力JSON フォーマット:
//   { tweets: [{text, user, time, url}, ...] }
//
// 出力JSON フォーマット:
//   { generatedAt, model, inputCount, classifiedCount, bubbles: [...], all: [...] }

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL_HAIKU || 'claude-haiku-4-5-20251001';

if (!ANTHROPIC_API_KEY) {
  console.error('[classify_x_pulse] ANTHROPIC_API_KEY is not set');
  process.exit(1);
}
// ASCII以外の文字が入っていたら（プレースホルダのままだったり、コピペ事故）早期エラー
if (!/^[\x20-\x7E]+$/.test(ANTHROPIC_API_KEY)) {
  console.error('[classify_x_pulse] ANTHROPIC_API_KEY に ASCII 以外の文字が含まれています。実際のAPIキー（sk-ant-...）に置き換えてください');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
  console.error(`[classify_x_pulse] ANTHROPIC_API_KEY の形式が想定外です（"${ANTHROPIC_API_KEY.slice(0, 10)}..." で開始）。"sk-ant-" 始まりのキーが必要`);
  process.exit(1);
}

// ---- args ----
const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const val = (i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[++i] : true;
    argMap[key] = val;
  }
}
const inputPath = argMap.input;
const outputPath = argMap.output;
const dry = !!argMap.dry;
if (!inputPath) {
  console.error('Usage: node scripts/classify_x_pulse.mjs --input <tweets.json> [--output <out.json>] [--dry]');
  process.exit(1);
}

// ---- constants ----
const BATCH_SIZE = 20;  // パス1で1リクエストあたりのツイート数
const SENTIMENT_SCORE = {
  '応援強': 2,
  '応援弱': 1,
  '中立': 0,
  '批判弱': -1,
  '批判強': -2,
};
// クラスタ内最小ツイート数（これ未満はバブル化しない or その他扱い）
// --min-cluster-size で上書き可能（小データの検証用に 1 にできる）
const MIN_CLUSTER_SIZE = parseInt(argMap['min-cluster-size'] || '2', 10);
// 罵倒語ブロックリスト（最小セット、運用で追加）
const PROFANITY_WORDS = ['死ね', '消えろ', 'クズ', 'ゴミ', '殺す'];

// ---- Anthropic API ----
async function callClaude(prompt, { temperature = 0.1, maxTokens = 4096 } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
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
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  // JSON配列の場合
  const arrStart = candidate.indexOf('[');
  const arrEnd = candidate.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    return JSON.parse(candidate.slice(arrStart, arrEnd + 1));
  }
  // JSONオブジェクトの場合
  const objStart = candidate.indexOf('{');
  const objEnd = candidate.lastIndexOf('}');
  if (objStart === -1 || objEnd === -1) throw new Error('No JSON found in response');
  return JSON.parse(candidate.slice(objStart, objEnd + 1));
}

// ---- Pass 1: per-tweet classification (batched) ----
function buildPass1Prompt(batch) {
  const numbered = batch.map((t, i) => `${i + 1}. ${t.text.replace(/\n+/g, ' ').slice(0, 280)}`).join('\n');
  return `あなたはカープ（広島東洋カープ）のファンツイートを分類するアシスタントです。
以下の${batch.length}件のツイートを1件ずつ分類し、JSON配列で返してください。

各ツイートに対して以下4つを判定:

1. targetType: 以下から1つ
   - "選手" : カープの個別選手（栗林、森下、床田、小園、坂倉、菊池、新井「貴浩」以外のカープ選手）の話題
   - "首脳陣" : カープの監督・コーチの采配・起用・継投の話題（新井監督、藤井投手コーチ、福地、朝山等）
   - "なし" : 上記いずれでもない（チーム全体への一般的応援/批判、グッズ、観戦報告のみ、ゲーム、ノイズ等）

2. target: 該当人物名（フルネームまたは姓のみ、例: "栗林" "新井"）。targetTypeが「なし」なら null

3. topic_broad: 以下から1つ
   - 選手の場合: "投球" | "打撃" | "守備" | "走塁" | "ホームラン" | "失策" | "離脱・復帰" | "起用・スタメン" | "その他"
   - 首脳陣の場合: "継投" | "代打" | "起用" | "スタメン" | "采配" | "その他"
   - targetTypeが「なし」なら null
   - 注意: 選手が「スタメン抜擢された/外された/2軍に落ちた」のような話題は選手の「起用・スタメン」を選ぶ

4. sentiment: 以下から1つ
   - "応援強" : 強い称賛・感謝・熱い応援（神/最高/泣いた/天才/感動）
   - "応援弱" : 期待・励まし・弱い肯定（頑張れ/期待/嬉しい）
   - "中立" : 情報共有・観戦報告・ニュースリンク（スタメン共有、結果伝達）
   - "批判弱" : 不安・心配・弱い疑問・違和感（やばい/心配/嫌な感じ）
   - "批判強" : 強い批判・怒り・責任追及（無能/責任問題/最悪/辞めろ）

【重要】
- カープと無関係なツイート（他チームファン、グッズ、ゲーム、グルメ等）は targetType="なし" にする
- 選手と首脳陣の両方に言及があれば、より強く感情が向いている方を選ぶ
- 皮肉・反語は字面ではなく意図で判定

ツイート:
${numbered}

出力フォーマット（JSON配列のみ、コメント・前置き不要）:
[
  {"i": 1, "targetType": "選手|首脳陣|なし", "target": "..." or null, "topic_broad": "..." or null, "sentiment": "..."},
  ...
]`;
}

async function pass1Classify(tweets) {
  const classified = [];
  for (let i = 0; i < tweets.length; i += BATCH_SIZE) {
    const batch = tweets.slice(i, i + BATCH_SIZE);
    const prompt = buildPass1Prompt(batch);
    console.error(`[pass1] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(tweets.length / BATCH_SIZE)} (${batch.length}件)`);
    let result;
    try {
      const raw = await callClaude(prompt, { temperature: 0.1, maxTokens: 2048 });
      result = extractJson(raw);
    } catch (e) {
      console.error(`[pass1] batch failed: ${e.message}`);
      // 失敗したバッチは「なし」扱いで埋める
      result = batch.map((_, j) => ({ i: j + 1, targetType: 'なし', target: null, topic_broad: null, sentiment: '中立' }));
    }
    // 結果を元ツイートにマージ
    batch.forEach((tweet, j) => {
      const cls = result.find(r => r.i === j + 1) || {};
      classified.push({
        ...tweet,
        targetType: cls.targetType || 'なし',
        target: cls.target || null,
        topic_broad: cls.topic_broad || null,
        sentiment: cls.sentiment || '中立',
      });
    });
  }
  return classified;
}

// ---- Pass 2: per-cluster specific label ----
function clusterKey(c) {
  return `${c.target}|${c.topic_broad}|${c.sentiment}`;
}

function buildClusters(classified) {
  const map = new Map();
  for (const c of classified) {
    // 「なし」「中立」はバブル化しない
    if (c.targetType === 'なし' || c.sentiment === '中立') continue;
    // 罵倒語フィルタ
    if (PROFANITY_WORDS.some(w => c.text.includes(w))) continue;
    // target が null の場合、targetType=「首脳陣」なら「首脳陣」を target とする
    //（個人名が明示されない首脳陣批判をバブル化するため）
    const effectiveTarget = c.target || (c.targetType === '首脳陣' ? '首脳陣' : null);
    if (!effectiveTarget) continue;
    const clusterC = { ...c, target: effectiveTarget };
    const key = clusterKey(clusterC);
    if (!map.has(key)) {
      map.set(key, { target: effectiveTarget, targetType: c.targetType, topic_broad: c.topic_broad, sentiment: c.sentiment, tweets: [] });
    }
    map.get(key).tweets.push(clusterC);
  }
  return Array.from(map.values()).filter(c => c.tweets.length >= MIN_CLUSTER_SIZE);
}

function buildPass2Prompt(cluster) {
  const numbered = cluster.tweets.map((t, i) => `${i + 1}. ${t.text.replace(/\n+/g, ' ').slice(0, 200)}`).join('\n');
  return `以下は「${cluster.target} × ${cluster.topic_broad} × ${cluster.sentiment}」に分類された${cluster.tweets.length}件のカープファンツイートです。
これらに共通する「具体的な話題」を1〜3語の日本語で要約してください。

良い例:
- 「継投が早い」（首脳陣×継投×批判強で、早めの交代に不満が集中）
- 「復帰期待」（栗林×離脱・復帰×応援弱で、復活を願う声）
- 「ナイス起用」（新井×起用×応援強で、名原の1番抜擢を称賛）
- 「責任問題」（首脳陣×継投×批判強で、選手怪我の責任を問う声）

悪い例:
- 「色々」「全般」（具体性がない）
- 長すぎる説明文

ツイート:
${numbered}

出力: ラベル文字列1つのみ（説明・前置き・引用符不要）`;
}

async function pass2Label(clusters) {
  const labeled = [];
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    console.error(`[pass2] cluster ${i + 1}/${clusters.length}: ${clusterKey(cluster)} (${cluster.tweets.length}件)`);
    let label;
    try {
      label = await callClaude(buildPass2Prompt(cluster), { temperature: 0.3, maxTokens: 50 });
      // 引用符・改行・記号を整理
      label = label.replace(/^["'「『]+|["'」』]+$/g, '').replace(/\n.*$/s, '').slice(0, 12);
    } catch (e) {
      console.error(`[pass2] cluster failed: ${e.message}`);
      label = cluster.topic_broad;
    }
    labeled.push({ ...cluster, label });
  }
  return labeled;
}

// ---- Pass 3: 全体サマリ (Haiku, 1文) ----
function buildPass3Prompt(bubbles, classified, phaseName) {
  const top = bubbles.slice(0, 8);
  const phaseLabel = ({ pre: '試合前', live: '試合中', post: '試合後' })[phaseName] || phaseName;
  const bubbleLines = top.length
    ? top.map((b, i) => `${i + 1}. ${b.target}｜${b.topic_label || b.topic_broad}｜${b.sentiment} (${b.count}件)`).join('\n')
    : '(クラスタなし)';
  const eligibleTweetCount = classified.filter(c => c.targetType !== 'なし').length;
  return `あなたはカープファンの ${phaseLabel} の Xでの盛り上がりを **1文** で要約するアシスタントです。

以下のバブル情報をベースに、「いま何が話題か」を **30〜60文字** で1文にまとめてください。

【バブル (件数順 Top${top.length})】
${bubbleLines}

【メタ情報】
- フェーズ: ${phaseLabel}
- 分類された関連ツイート: ${eligibleTweetCount}件 / 取得 ${classified.length}件
- バブル総数: ${bubbles.length}個

【良い例】
- 「名原のスタメン抜擢に期待の声が集中、森下の好投も評価」
- 「劇的勝利、栗林代役の活躍を讃える声が多数」
- 「首脳陣の継投ミスに批判集中、選手は奮闘で応援殺到」

【悪い例】
- 「いろんな話題が出ています」（具体性なし）
- 長すぎる文 (80字以上)
- 箇条書き

出力: 1文の日本語テキストのみ（引用符・前置き不要）`;
}

async function pass3Summary(bubbles, classified, phaseName) {
  console.error('[pass3] generating summary...');
  try {
    const raw = await callClaude(buildPass3Prompt(bubbles, classified, phaseName), { temperature: 0.5, maxTokens: 200 });
    // 改行や引用符を整理、最大100字
    const summary = raw
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .replace(/\n.*$/s, '')
      .slice(0, 100);
    console.error(`[pass3] summary: ${summary}`);
    return summary;
  } catch (e) {
    console.error(`[pass3] failed: ${e.message}`);
    return null;
  }
}

// ---- Build bubbles ----
function buildBubbles(labeledClusters) {
  return labeledClusters.map(c => ({
    target: c.target,
    targetType: c.targetType,
    topic_broad: c.topic_broad,
    topic_label: c.label,
    sentiment: c.sentiment,
    sentimentScore: SENTIMENT_SCORE[c.sentiment] ?? 0,
    count: c.tweets.length,
    tweetUrls: c.tweets.map(t => t.url).filter(Boolean).slice(0, 5),
    sampleTexts: c.tweets.slice(0, 3).map(t => ({
      text: t.text.slice(0, 100),
      user: t.user,
      time: t.time,
    })),
  })).sort((a, b) => b.count - a.count);
}

// ---- Main ----
async function main() {
  const inputRaw = await fs.readFile(path.resolve(inputPath), 'utf8');
  const input = JSON.parse(inputRaw);
  const tweets = input.tweets || [];
  console.error(`[classify_x_pulse] input: ${tweets.length}件`);
  if (tweets.length === 0) {
    console.error('[classify_x_pulse] no tweets to classify');
    process.exit(0);
  }

  console.error('[classify_x_pulse] === Pass 1: per-tweet classification ===');
  const classified = await pass1Classify(tweets);
  console.error(`[classify_x_pulse] pass1 done: ${classified.length}件`);

  console.error('[classify_x_pulse] === Building clusters ===');
  const clusters = buildClusters(classified);
  console.error(`[classify_x_pulse] clusters: ${clusters.length}個 (min size ${MIN_CLUSTER_SIZE})`);

  console.error('[classify_x_pulse] === Pass 2: per-cluster label ===');
  const labeled = await pass2Label(clusters);

  const bubbles = buildBubbles(labeled);

  console.error('[classify_x_pulse] === Pass 3: overall summary ===');
  // phase 名は output path から推測（例: games/x_pulse/2026-05-24/pre.json → "pre"）
  const phaseName = outputPath
    ? (outputPath.match(/\/(pre|live|post)\.json$/i)?.[1] || null)
    : null;
  const summary = await pass3Summary(bubbles, classified, phaseName);

  const output = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    inputCount: tweets.length,
    classifiedCount: classified.length,
    clusterCount: clusters.length,
    bubbleCount: bubbles.length,
    summary,
    bubbles,
    // デバッグ用に分類結果一覧も保持（後で容量が問題になったら削れる）
    all: classified,
  };

  if (dry) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const outPath = outputPath ? path.resolve(outputPath) : path.join(REPO_ROOT, 'games', 'x_pulse_test.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[classify_x_pulse] Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(`[classify_x_pulse] ERROR: ${e.message}`);
  process.exit(1);
});
