-- Manual courier assignment and delivery status tracking.
begin;

create table if not exists public.delivery_assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  courier_id uuid not null references public.profiles(id),
  assigned_by uuid not null references auth.users(id),
  status text not null default 'assigned'
    check (status in ('assigned', 'picked_up', 'delivered', 'cancelled')),
  assigned_at timestamptz not null default now(),
  picked_up_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists delivery_assignments_courier_idx
  on public.delivery_assignments(courier_id, assigned_at desc);
alter table public.delivery_assignments enable row level security;

drop policy if exists "related users read delivery assignments" on public.delivery_assignments;
create policy "related users read delivery assignments"
on public.delivery_assignments for select to authenticated
using (
  courier_id = auth.uid()
  or exists(select 1 from public.orders o where o.id=order_id and o.customer_id=auth.uid())
  or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
);

-- Writes are performed only by the role-checked Edge Function using service_role.
revoke all on public.delivery_assignments from public, anon, authenticated;

commit;
