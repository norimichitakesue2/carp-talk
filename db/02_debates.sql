-- 軸2（議論エンジン）用のテーブル
-- Supabase SQL Editor で実行してください

-- === debate_votes ===
-- 各論点（debates 配列内のid）への投票
create table if not exists debate_votes (
  game_id     text not null,
  debate_id   text not null,
  user_id     text not null,
  choice_idx  int  not null check (choice_idx between 0 and 9),
  created_at  timestamptz default now(),
  primary key (debate_id, user_id)
);

create index if not exists debate_votes_game_idx on debate_votes(game_id);
create index if not exists debate_votes_debate_idx on debate_votes(debate_id);

alter table debate_votes enable row level security;

drop policy if exists "debate_votes read all"   on debate_votes;
drop policy if exists "debate_votes insert all" on debate_votes;
drop policy if exists "debate_votes delete all" on debate_votes;

create policy "debate_votes read all"
  on debate_votes for select using (true);

create policy "debate_votes insert all"
  on debate_votes for insert with check (true);

create policy "debate_votes delete all"
  on debate_votes for delete using (true);

-- === debate_comments ===
-- 各論点へのコメント。choice_idx を持つことで「この立場の人のコメント」が分かる
create table if not exists debate_comments (
  id          uuid primary key default gen_random_uuid(),
  game_id     text not null,
  debate_id   text not null,
  user_id     text not null,
  choice_idx  int,                -- そのユーザーがどの立場で発言したか（NULL可）
  body        text not null check (char_length(body) between 1 and 240),
  created_at  timestamptz default now()
);

create index if not exists debate_comments_debate_idx on debate_comments(debate_id, created_at desc);

alter table debate_comments enable row level security;

drop policy if exists "debate_comments read all"   on debate_comments;
drop policy if exists "debate_comments insert all" on debate_comments;

create policy "debate_comments read all"
  on debate_comments for select using (true);

create policy "debate_comments insert all"
  on debate_comments for insert with check (true);
