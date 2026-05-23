// GitHub Contents API でファイルを add/update する。
// sandbox の .git/lock 制約を回避するために、git push の代わりに使う。
//
// 使い方:
//   node scripts/push_to_github_api.mjs \
//     --file <local file path> \
//     --remote-path <path in repo> \
//     --message <commit message>
//
// 必須環境変数:
//   GITHUB_TOKEN: Personal Access Token (fine-grained で carp-talk repo の Contents:R/W 権限)
//
// 例:
//   GITHUB_TOKEN=ghp_xxx node scripts/push_to_github_api.mjs \
//     --file /tmp/x_pulse_classified_2026-05-23_live.json \
//     --remote-path games/x_pulse/2026-05-23/live.json \
//     --message "data: x_pulse 2026-05-23 live"

import fs from 'node:fs/promises';

const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const val = (i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[++i] : true;
    argMap[key] = val;
  }
}

const filePath = argMap.file;
const remotePath = argMap['remote-path'];
const message = argMap.message;
const OWNER = process.env.GH_OWNER || 'norimichitakesue2';
const REPO = process.env.GH_REPO || 'carp-talk';
const BRANCH = process.env.GH_BRANCH || 'main';
const COMMITTER_NAME = process.env.GH_COMMITTER_NAME || 'x-pulse-bot';
const COMMITTER_EMAIL = process.env.GH_COMMITTER_EMAIL || 'x-pulse-bot@users.noreply.github.com';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('[gh-push] GITHUB_TOKEN env var not set');
  process.exit(1);
}
if (!/^[\x20-\x7E]+$/.test(TOKEN)) {
  console.error('[gh-push] GITHUB_TOKEN に ASCII以外の文字。実値に置換してください');
  process.exit(1);
}

if (!filePath || !remotePath || !message) {
  console.error('Usage: --file <local path> --remote-path <repo path> --message <msg>');
  process.exit(1);
}

const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${remotePath}`;
const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'carp-talk-x-pulse-bot',
};

async function getExistingSha() {
  // ?ref=<branch> でブランチ指定。404 = 新規ファイル
  const url = `${API_BASE}?ref=${encodeURIComponent(BRANCH)}`;
  const res = await fetch(url, { headers });
  if (res.status === 200) {
    const data = await res.json();
    return data.sha;
  }
  if (res.status === 404) {
    return null;
  }
  const t = await res.text();
  throw new Error(`GET failed ${res.status}: ${t.slice(0, 200)}`);
}

async function putFile(contentB64, sha) {
  const body = {
    message,
    content: contentB64,
    branch: BRANCH,
    committer: { name: COMMITTER_NAME, email: COMMITTER_EMAIL },
  };
  if (sha) body.sha = sha;

  const res = await fetch(API_BASE, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`PUT failed ${res.status}: ${txt.slice(0, 400)}`);
  }
  return JSON.parse(txt);
}

async function main() {
  const sha = await getExistingSha();
  if (sha) {
    console.error(`[gh-push] existing file SHA: ${sha.slice(0, 8)}…`);
  } else {
    console.error('[gh-push] file does not exist, will create');
  }

  const content = await fs.readFile(filePath);
  const contentB64 = content.toString('base64');
  console.error(`[gh-push] file size: ${content.length}B → base64 ${contentB64.length}B`);

  // GitHub Contents API は最大 100MB だが、大きいと不安定なので5MBで警告
  if (content.length > 5_000_000) {
    console.error('[gh-push] WARNING: file >5MB, API may be slow or fail');
  }

  // リトライ: SHA競合 (409/422) は再取得して1回だけリトライ
  let result;
  try {
    result = await putFile(contentB64, sha);
  } catch (e) {
    if (e.message.includes('409') || e.message.includes('422')) {
      console.error(`[gh-push] conflict detected, re-fetching SHA and retry: ${e.message}`);
      const newSha = await getExistingSha();
      result = await putFile(contentB64, newSha);
    } else {
      throw e;
    }
  }

  console.error(`[gh-push] ✅ OK. commit ${result.commit?.sha?.slice(0, 8)} / ${remotePath}`);
  console.log(JSON.stringify({
    ok: true,
    commitSha: result.commit?.sha,
    fileSha: result.content?.sha,
    htmlUrl: result.content?.html_url,
  }));
}

main().catch((e) => {
  console.error(`[gh-push] ❌ ERROR: ${e.message}`);
  process.exit(1);
});
