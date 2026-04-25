// NPB team code <-> full name mapping
// NPB の試合URL形式: /scores/YYYY/MMDD/<home>-<away>-<gameNum>/
//   例: c-s-05 = 広島(home) vs ヤクルト(away) 5回戦
//       db-g-04 = DeNA(home) vs 巨人(away) 4回戦

export const TEAM_BY_CODE = {
  c:  '広島',
  g:  '巨人',
  t:  '阪神',
  s:  'ヤクルト',
  db: 'DeNA',
  d:  '中日',
  h:  'ソフトバンク',
  m:  'ロッテ',
  l:  '西武',
  e:  '楽天',
  b:  'オリックス',
  f:  '日本ハム',
};

export const FULL_NAME_BY_SHORT = {
  '広島':      '広島東洋カープ',
  '巨人':      '読売ジャイアンツ',
  '阪神':      '阪神タイガース',
  'ヤクルト':  '東京ヤクルトスワローズ',
  'DeNA':      '横浜DeNAベイスターズ',
  '中日':      '中日ドラゴンズ',
  'ソフトバンク': '福岡ソフトバンクホークス',
  'ロッテ':    '千葉ロッテマリーンズ',
  '西武':      '埼玉西武ライオンズ',
  '楽天':      '東北楽天ゴールデンイーグルス',
  'オリックス': 'オリックス・バファローズ',
  '日本ハム':  '北海道日本ハムファイターズ',
};

export const CODE_BY_SHORT = Object.fromEntries(
  Object.entries(TEAM_BY_CODE).map(([k, v]) => [v, k])
);

// 表示用のチーム短縮名（ホームページの表記に揃える）
export const SHORT_NAMES = Object.values(TEAM_BY_CODE);

// URLセグメントにカープが含まれるか
export function isCarpGame(urlSegment) {
  const parts = urlSegment.split('-');
  return parts.includes('c');
}

// URLセグメント (例: "c-s-05") をパース。home が先頭、away が次。
export function parseGameSegment(segment) {
  const parts = segment.split('-');
  if (parts.length < 3) return null;
  const gameNum = parts[parts.length - 1];
  const homeCode = parts[0];
  const awayCode = parts[parts.length - 2];
  return {
    homeCode,
    awayCode,
    homeTeam: TEAM_BY_CODE[homeCode] || homeCode,
    awayTeam: TEAM_BY_CODE[awayCode] || awayCode,
    gameNum: parseInt(gameNum, 10) || 1,
  };
}
