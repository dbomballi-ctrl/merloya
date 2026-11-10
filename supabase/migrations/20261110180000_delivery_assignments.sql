-- Manual courier assignment and delivery status tracking.
begin;

-- The courier role is provisioned only by administrators, never by public signup.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role = any (array['usuario'::text, 'comercio'::text, 'admin'::text, 'repartidor'::text]));

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
as $$
  select exists (
    select 1 from public.delivery_assignments da
    where da.order_id = p_order_id and da.courier_id = auth.uid()
  );
$$;

create or replace function public.merlo_is_current_user_order_customer(p_order_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.customer_id = auth.uid()
  );
$$;

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

-- Update courier delivery state and merchant suborders as one transaction.
create or replace function public.update_merlo_delivery_status(
  p_order_id uuid,
  p_next_status text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment public.delivery_assignments%rowtype;
  v_role text;
begin
  if p_order_id is null or p_actor_id is null
     or p_next_status not in ('picked_up', 'delivered') then
    raise exception 'Invalid delivery status payload';
  end if;

  select role into v_role from public.profiles where id = p_actor_id;
  if v_role is distinct from 'repartidor' then
    raise exception 'DELIVERY_UPDATE_FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_assignment
  from public.delivery_assignments
  where order_id = p_order_id
  for update;

  if not found or v_assignment.courier_id <> p_actor_id then
    raise exception 'DELIVERY_ASSIGNMENT_NOT_OWNED' using errcode = '42501';
  end if;

  if not (
    (v_assignment.status = 'assigned' and p_next_status = 'picked_up')
    or (v_assignment.status = 'picked_up' and p_next_status = 'delivered')
  ) then
    raise exception 'DELIVERY_STATUS_CONFLICT' using errcode = '22023';
  end if;

  update public.delivery_assignments
  set status = p_next_status, updated_at = now(),
      picked_up_at = case when p_next_status = 'picked_up' then now() else picked_up_at end,
      delivered_at = case when p_next_status = 'delivered' then now() else delivered_at end
  where id = v_assignment.id;

  update public.merchant_orders
  set status = case when p_next_status = 'picked_up' then 'dispatched' else 'delivered' end
  where order_id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'status', p_next_status);
end;
$$;

revoke all on function public.update_merlo_delivery_status(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.update_merlo_delivery_status(uuid, text, uuid)
  to service_role;

commit;
