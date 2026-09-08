-- ══════════════════════════════════════════════════════════════
-- Urlsify — account layer schema
-- Run in the Supabase SQL editor (or via `apply_migration` once the
-- MCP token is scoped to the org that owns this project).
--
-- Cloudflare KV stays the source of truth for redirects. This table
-- is the user's library: what they made, when, and how it performed.
-- ══════════════════════════════════════════════════════════════

create table if not exists public.links (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  code         text not null,
  destination  text not null,
  tag          text,
  clicks       integer not null default 0,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint links_user_code_unique unique (user_id, code)
);

create index if not exists links_user_created_idx
  on public.links (user_id, created_at desc);

create index if not exists links_user_tag_idx
  on public.links (user_id, tag);

-- keep updated_at honest
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists links_touch_updated_at on public.links;

create trigger links_touch_updated_at
  before update on public.links
  for each row execute function public.touch_updated_at();

-- ── Row level security: a user only ever sees their own rows ──
alter table public.links enable row level security;

drop policy if exists "links_select_own" on public.links;
create policy "links_select_own" on public.links
  for select using (auth.uid() = user_id);

drop policy if exists "links_insert_own" on public.links;
create policy "links_insert_own" on public.links
  for insert with check (auth.uid() = user_id);

drop policy if exists "links_update_own" on public.links;
create policy "links_update_own" on public.links
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "links_delete_own" on public.links;
create policy "links_delete_own" on public.links
  for delete using (auth.uid() = user_id);
