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

-- Security-definer predicates avoid recursive RLS when orders and assignments
-- refer to each other for customer/courier visibility.
create or replace function public.merlo_is_current_user_assigned_courier(p_order_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $
  select exists (
    select 1 from public.delivery_assignments da
    where da.order_id = p_order_id and da.courier_id = auth.uid()
  );
$;

create or replace function public.merlo_is_current_user_order_customer(p_order_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.customer_id = auth.uid()
  );
$;

revoke all on function public.merlo_is_current_user_assigned_courier(uuid) from public, anon;
revoke all on function public.merlo_is_current_user_order_customer(uuid) from public, anon;
grant execute on function public.merlo_is_current_user_assigned_courier(uuid) to authenticated;
grant execute on function public.merlo_is_current_user_order_customer(uuid) to authenticated;

drop policy if exists "couriers read assigned delivery orders" on public.orders;
create policy "couriers read assigned delivery orders"
on public.orders for select to authenticated
using (public.merlo_is_current_user_assigned_courier(id));

drop policy if exists "related users read delivery assignments" on public.delivery_assignments;
create policy "related users read delivery assignments"
on public.delivery_assignments for select to authenticated
using (
  courier_id = auth.uid()
  or public.merlo_is_current_user_order_customer(order_id)
  or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
);

-- Writes are performed only by the role-checked Edge Function using service_role.
revoke all on public.delivery_assignments from public, anon, authenticated;
grant select on public.delivery_assignments to authenticated;

commit;
