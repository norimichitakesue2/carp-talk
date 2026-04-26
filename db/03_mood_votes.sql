-- 気分チェックイン用のテーブル
-- Supabase SQL Editor で実行してください

create table if not exists mood_votes (
  game_id    text not null,
  user_id    text not null,
  mood       text not null check (mood in ('angry', 'sigh', 'mixed', 'light', 'best')),
  created_at timestamptz default now(),
  primary key (game_id, user_id)
);

create index if not exists mood_votes_game_idx on mood_votes(game_id);

alter table mood_votes enable row level security;

drop policy if exists "mood_votes read all"   on mood_votes;
drop policy if exists "mood_votes insert all" on mood_votes;
drop policy if exists "mood_votes update all" on mood_votes;
drop policy if exists "mood_votes delete all" on mood_votes;

create policy "mood_votes read all"
  on mood_votes for select using (true);

create policy "mood_votes insert all"
  on mood_votes for insert with check (true);

create policy "mood_votes update all"
  on mood_votes for update using (true);

create policy "mood_votes delete all"
  on mood_votes for delete using (true);
