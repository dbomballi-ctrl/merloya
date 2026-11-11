-- Harden the legacy public profile/sales policies and merchant product writes.
begin;

create or replace function public.merlo_is_current_user_admin()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;
revoke all on function public.merlo_is_current_user_admin() from public, anon;
grant execute on function public.merlo_is_current_user_admin() to authenticated;

-- Remove unrestricted public profile read/insert. Signup is handled by the
-- SECURITY DEFINER auth trigger; clients can no longer self-assign a role.
drop policy if exists "Permitir lectura publica de perfiles" on public.profiles;
drop policy if exists "Permitir insercion de perfiles" on public.profiles;
drop policy if exists "profiles public read merchants" on public.profiles;
drop policy if exists "profiles users read own profile" on public.profiles;
drop policy if exists "profiles admins read couriers" on public.profiles;
drop policy if exists "profiles users update own location" on public.profiles;

create policy "profiles public read merchants"
on public.profiles for select to anon, authenticated
using (role = 'comercio');

create policy "profiles users read own profile"
on public.profiles for select to authenticated
using (id = auth.uid());

create policy "profiles admins read couriers"
on public.profiles for select to authenticated
using (role = 'repartidor' and public.merlo_is_current_user_admin());

create policy "profiles users update own location"
on public.profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

revoke all on public.profiles from anon, authenticated;
grant select (id, nombre, rubro, zona) on public.profiles to anon;
grant select (id, nombre, rubro, zona, role, latitude, longitude)
  on public.profiles to authenticated;
grant update (latitude, longitude) on public.profiles to authenticated;

create or replace view public.public_merchants
with (security_invoker = true)
as
select id, nombre, rubro, zona
from public.profiles
where role = 'comercio';
grant select on public.public_merchants to anon, authenticated;

-- Product write permissions are reserved for actual commerce accounts.
drop policy if exists "Comercios pueden insertar sus productos" on public.products;
drop policy if exists "Comercios pueden actualizar sus productos" on public.products;
drop policy if exists "Comercios pueden eliminar sus productos" on public.products;

create policy "merchants insert own products"
on public.products for insert to authenticated
with check (
  auth.uid() = comercio_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'comercio')
);

create policy "merchants update own products"
on public.products for update to authenticated
using (
  auth.uid() = comercio_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'comercio')
)
with check (
  auth.uid() = comercio_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'comercio')
);

create policy "merchants delete own products"
on public.products for delete to authenticated
using (
  auth.uid() = comercio_id
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'comercio')
);

revoke insert, update, delete on public.products from anon, authenticated;
grant insert, update, delete on public.products to authenticated;

-- Sales is legacy functionality; keep scoped reads for the buyer, merchant,
-- or admin, and remove public write access. The 2.0 checkout writes orders.
drop policy if exists "Permitir todo en sales" on public.sales;
drop policy if exists "sales related users read" on public.sales;
create policy "sales related users read"
on public.sales for select to authenticated
using (
  usuario_id = auth.uid()
  or comercio_id = auth.uid()
  or public.merlo_is_current_user_admin()
);
revoke all on public.sales from anon, authenticated;
grant select on public.sales to authenticated;

-- Trigger functions are not RPC endpoints; fix the mutable search_path warning
-- and prevent direct SECURITY DEFINER invocation through the Data API.
alter function public.set_merlo_updated_at() set search_path = public, pg_temp;
alter function public.refresh_merlo_order_payment_status() set search_path = public, pg_temp;
revoke all on function public.set_merlo_updated_at() from public, anon, authenticated;
revoke all on function public.refresh_merlo_order_payment_status() from public, anon, authenticated;
grant execute on function public.set_merlo_updated_at() to service_role;
grant execute on function public.refresh_merlo_order_payment_status() to service_role;

commit;
