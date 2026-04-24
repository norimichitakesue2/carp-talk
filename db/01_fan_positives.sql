-- 軸1（ポジ3レイヤー）用のテーブル
-- Supabase SQL Editor で実行してください
--
-- 実行後、anon key でも読み書きできるようRLSを緩めています（他テーブルと同じ方針）。
-- 必要に応じて rate_limit / トリガーで濫用防止を入れてください。

-- === fan_positives ===
-- レイヤー3「ファンが見つけた光」の投稿
create table if not exists fan_positives (
  id uuid primary key default gen_random_uuid(),
  game_id text not null,
  user_id text not null,
  body text not null check (char_length(body) between 1 and 240),
  created_at timestamptz default now()
);

create index if not exists fan_positives_game_idx on fan_positives(game_id);
create index if not exists fan_positives_created_idx on fan_positives(created_at desc);

alter table fan_positives enable row level security;

drop policy if exists "fan_positives read all"   on fan_positives;
drop policy if exists "fan_positives insert all" on fan_positives;

create policy "fan_positives read all"
  on fan_positives for select using (true);

create policy "fan_positives insert all"
  on fan_positives for insert with check (true);

-- === fan_positive_likes ===
-- 「わかる」投票。positive_id はキュレーションposi (例: p23_1) もファン投稿posi (uuid) も両方受けるので text 型にしている
create table if not exists fan_positive_likes (
  positive_id text not null,
  user_id     text not null,
  created_at  timestamptz default now(),
  primary key (positive_id, user_id)
);

create index if not exists fan_positive_likes_pid_idx on fan_positive_likes(positive_id);

alter table fan_positive_likes enable row level security;

drop policy if exists "fan_positive_likes read all"   on fan_positive_likes;
drop policy if exists "fan_positive_likes insert all" on fan_positive_likes;
drop policy if exists "fan_positive_likes delete all" on fan_positive_likes;

create policy "fan_positive_likes read all"
  on fan_positive_likes for select using (true);

create policy "fan_positive_likes insert all"
  on fan_positive_likes for insert with check (true);

create policy "fan_positive_likes delete all"
  on fan_positive_likes for delete using (true);
