create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member',
  added_by uuid null references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint room_members_pkey primary key (room_id, user_id),
  constraint room_members_role_check check (role in ('admin', 'member'))
);

create index if not exists room_members_user_id_idx on public.room_members (user_id);

create table if not exists public.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  target_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz null,
  constraint room_invites_status_check check (status in ('pending', 'accepted', 'declined', 'canceled'))
);

create index if not exists room_invites_room_id_idx on public.room_invites (room_id);
create index if not exists room_invites_requester_id_idx on public.room_invites (requester_id);
create index if not exists room_invites_target_id_idx on public.room_invites (target_id);
