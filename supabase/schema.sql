begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  balance numeric(12, 2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.wallet_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.wallet_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('deposit', 'withdrawal')),
  amount numeric(12, 2) not null check (amount > 0),
  note text not null default '' check (char_length(note) <= 250),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_note text not null default '' check (char_length(admin_note) <= 500),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);

create index if not exists wallet_requests_user_created_idx
  on public.wallet_requests (user_id, created_at desc);
create index if not exists wallet_requests_status_created_idx
  on public.wallet_requests (status, created_at asc);

create or replace function public.is_wallet_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.wallet_admins
    where user_id = auth.uid()
  );
$$;

revoke all on function public.is_wallet_admin() from public, anon;
grant execute on function public.is_wallet_admin() to authenticated;

create or replace function public.create_wallet_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'display_name', '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_wallet_profile on auth.users;
create trigger on_auth_user_created_wallet_profile
  after insert on auth.users
  for each row execute function public.create_wallet_profile();

create or replace function public.submit_wallet_request(
  p_kind text,
  p_amount numeric,
  p_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_id uuid := auth.uid();
  current_balance numeric(12, 2);
  pending_withdrawals numeric(12, 2);
  request_id uuid;
begin
  if requester_id is null then
    raise exception 'Sign in before submitting a request.' using errcode = '28000';
  end if;
  if p_kind not in ('deposit', 'withdrawal') then
    raise exception 'Request type must be deposit or withdrawal.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    raise exception 'Enter an amount between GHS 0.01 and GHS 1,000,000.' using errcode = '22023';
  end if;
  if coalesce(char_length(p_note), 0) > 250 then
    raise exception 'Request note must be 250 characters or fewer.' using errcode = '22023';
  end if;

  if p_kind = 'withdrawal' then
    select balance into current_balance
    from public.profiles
    where user_id = requester_id
    for update;

    if current_balance is null then
      raise exception 'Your GHS profile is not ready. Refresh and try again.' using errcode = '22023';
    end if;

    select coalesce(sum(amount), 0) into pending_withdrawals
    from public.wallet_requests
    where user_id = requester_id
      and kind = 'withdrawal'
      and status = 'pending';

    if current_balance - pending_withdrawals < p_amount then
      raise exception 'Insufficient GHS balance for this withdrawal request.' using errcode = '22023';
    end if;
  end if;

  insert into public.wallet_requests (user_id, kind, amount, note)
  values (requester_id, p_kind, round(p_amount, 2), coalesce(p_note, ''))
  returning id into request_id;

  return request_id;
end;
$$;

create or replace function public.review_wallet_request(
  p_request_id uuid,
  p_approve boolean,
  p_admin_note text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.wallet_requests%rowtype;
  updated_balance numeric(12, 2);
begin
  if auth.uid() is null or not public.is_wallet_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;
  if coalesce(char_length(p_admin_note), 0) > 500 then
    raise exception 'Admin note must be 500 characters or fewer.' using errcode = '22023';
  end if;

  select * into request_row
  from public.wallet_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Wallet request not found.' using errcode = 'P0002';
  end if;
  if request_row.status <> 'pending' then
    raise exception 'This request has already been reviewed.' using errcode = '22023';
  end if;

  if p_approve then
    if request_row.kind = 'deposit' then
      update public.profiles
      set balance = balance + request_row.amount
      where user_id = request_row.user_id;
    else
      update public.profiles
      set balance = balance - request_row.amount
      where user_id = request_row.user_id
        and balance >= request_row.amount
      returning balance into updated_balance;

      if not found then
        raise exception 'The user no longer has enough GHS balance to approve this withdrawal.' using errcode = '22023';
      end if;
    end if;
  end if;

  update public.wallet_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      admin_note = coalesce(p_admin_note, ''),
      reviewed_at = now(),
      reviewed_by = auth.uid()
  where id = p_request_id;
end;
$$;

revoke all on function public.submit_wallet_request(text, numeric, text) from public, anon;
revoke all on function public.review_wallet_request(uuid, boolean, text) from public, anon;
grant execute on function public.submit_wallet_request(text, numeric, text) to authenticated;
grant execute on function public.review_wallet_request(uuid, boolean, text) to authenticated;

alter table public.profiles enable row level security;
alter table public.wallet_admins enable row level security;
alter table public.wallet_requests enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.wallet_admins from anon, authenticated;
revoke all on public.wallet_requests from anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.wallet_requests to authenticated;

drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin
  on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_wallet_admin());

drop policy if exists wallet_requests_select_self_or_admin on public.wallet_requests;
create policy wallet_requests_select_self_or_admin
  on public.wallet_requests for select to authenticated
  using (user_id = auth.uid() or public.is_wallet_admin());

-- After creating your admin account, run this in the Supabase SQL Editor with its email:
-- insert into public.wallet_admins (user_id)
-- select id from auth.users where email = 'admin@example.com'
-- on conflict (user_id) do nothing;

commit;
