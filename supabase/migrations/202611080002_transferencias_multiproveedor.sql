-- Merlo Ya: checkout por transferencia, pedidos multiproveedor y tarifas por distancia.
-- Migración aditiva: conserva profiles, products y sales existentes.
begin;

alter table public.profiles
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

create table if not exists public.merchant_payment_accounts (
  merchant_id uuid primary key references public.profiles(id) on delete cascade,
  account_holder text not null,
  bank_name text,
  cbu text,
  alias text,
  updated_at timestamptz not null default now(),
  constraint merchant_account_has_destination check (
    nullif(trim(coalesce(cbu,'')), '') is not null
    or nullif(trim(coalesce(alias,'')), '') is not null
  )
);
alter table public.merchant_payment_accounts enable row level security;

drop policy if exists "merchant reads own bank account" on public.merchant_payment_accounts;
create policy "merchant reads own bank account"
on public.merchant_payment_accounts for select to authenticated
using (merchant_id = auth.uid());

drop policy if exists "merchant manages own bank account" on public.merchant_payment_accounts;
create policy "merchant manages own bank account"
on public.merchant_payment_accounts for all to authenticated
using (
  merchant_id = auth.uid()
  and exists (select 1 from public.profiles p where p.id=auth.uid() and p.role='comercio')
)
with check (
  merchant_id = auth.uid()
  and exists (select 1 from public.profiles p where p.id=auth.uid() and p.role='comercio')
);

create table if not exists public.platform_settings (
  id boolean primary key default true check (id),
  account_holder text,
  bank_name text,
  cbu text,
  alias text,
  currency text not null default 'ARS' check (currency='ARS'),
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;
drop policy if exists "authenticated read platform payment destination" on public.platform_settings;
create policy "authenticated read platform payment destination"
on public.platform_settings for select to authenticated using (true);
-- Escritura solo desde Edge Functions con service_role.

create table if not exists public.delivery_rate_tiers (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  min_km numeric(8,2) not null default 0 check (min_km >= 0),
  max_km numeric(8,2),
  fee numeric(12,2) not null check (fee >= 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint valid_distance_range check (max_km is null or max_km > min_km)
);
alter table public.delivery_rate_tiers enable row level security;
drop policy if exists "authenticated read active delivery rates" on public.delivery_rate_tiers;
create policy "authenticated read active delivery rates"
on public.delivery_rate_tiers for select to authenticated using (active);
-- La edición de tarifas se realiza desde Edge Function/admin; no hay escritura directa.

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id),
  delivery_address text not null,
  delivery_zone text,
  delivery_latitude double precision not null,
  delivery_longitude double precision not null,
  customer_phone text,
  status text not null default 'awaiting_transfers'
    check (status in ('awaiting_transfers','payment_review','confirmed','cancelled')),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  shipping_total numeric(12,2) not null check (shipping_total >= 0),
  total_amount numeric(12,2) not null check (total_amount > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_customer_created_idx on public.orders(customer_id, created_at desc);
alter table public.orders enable row level security;

create table if not exists public.merchant_orders (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  merchant_id uuid not null references public.profiles(id),
  status text not null default 'awaiting_transfers'
    check (status in ('awaiting_transfers','payment_review','confirmed','preparing','dispatched','delivered','cancelled')),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  route_distance_km numeric(8,2) not null check (route_distance_km >= 0),
  shipping_fee numeric(12,2) not null check (shipping_fee >= 0),
  delivery_rate_tier_id uuid references public.delivery_rate_tiers(id),
  delivery_address_snapshot text not null,
  merchant_name_snapshot text not null,
  created_at timestamptz not null default now(),
  unique(order_id, merchant_id)
);
create index if not exists merchant_orders_merchant_created_idx on public.merchant_orders(merchant_id, created_at desc);
alter table public.merchant_orders enable row level security;

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  merchant_order_id uuid not null references public.merchant_orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name_snapshot text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  line_total numeric(12,2) generated always as (unit_price * quantity) stored
);
alter table public.order_items enable row level security;

create table if not exists public.transfer_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  merchant_order_id uuid references public.merchant_orders(id) on delete cascade,
  payee_type text not null check (payee_type in ('merchant','merlo_ya')),
  merchant_id uuid references public.profiles(id),
  amount numeric(12,2) not null check (amount > 0),
  destination_snapshot jsonb not null,
  status text not null default 'awaiting_transfer'
    check (status in ('awaiting_transfer','proof_submitted','verified','rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  constraint merchant_payment_requires_merchant check (
    (payee_type='merchant' and merchant_id is not null and merchant_order_id is not null)
    or (payee_type='merlo_ya' and merchant_id is null and merchant_order_id is not null)
  )
);
create index if not exists transfer_payments_order_idx on public.transfer_payments(order_id);
create index if not exists transfer_payments_merchant_idx on public.transfer_payments(merchant_id, created_at desc);
alter table public.transfer_payments enable row level security;

create table if not exists public.payment_proofs (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.transfer_payments(id) on delete cascade,
  storage_path text not null unique,
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now()
);
alter table public.payment_proofs enable row level security;

-- Lectura restringida: cliente dueño, comercio destinatario o administrador.
drop policy if exists "customers read own orders" on public.orders;
create policy "customers read own orders" on public.orders for select to authenticated
using (customer_id=auth.uid() or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'));

drop policy if exists "read relevant merchant orders" on public.merchant_orders;
create policy "read relevant merchant orders" on public.merchant_orders for select to authenticated
using (
  merchant_id=auth.uid()
  or exists(select 1 from public.orders o where o.id=order_id and o.customer_id=auth.uid())
  or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
);

drop policy if exists "read relevant order items" on public.order_items;
create policy "read relevant order items" on public.order_items for select to authenticated
using (
  exists(select 1 from public.merchant_orders mo join public.orders o on o.id=mo.order_id
    where mo.id=merchant_order_id and (mo.merchant_id=auth.uid() or o.customer_id=auth.uid()
      or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')))
);

drop policy if exists "read relevant transfer payments" on public.transfer_payments;
create policy "read relevant transfer payments" on public.transfer_payments for select to authenticated
using (
  exists(select 1 from public.orders o where o.id=order_id and o.customer_id=auth.uid())
  or (payee_type='merchant' and merchant_id=auth.uid())
  or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
);

drop policy if exists "read relevant payment proofs" on public.payment_proofs;
create policy "read relevant payment proofs" on public.payment_proofs for select to authenticated
using (
  uploaded_by=auth.uid()
  or exists(select 1 from public.transfer_payments tp
    left join public.merchant_orders mo on mo.id=tp.merchant_order_id
    left join public.orders o on o.id=tp.order_id
    where tp.id=payment_id and (o.customer_id=auth.uid() or mo.merchant_id=auth.uid()
      or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')))
);

-- El cliente solo puede adjuntar un comprobante a una obligación de pago de su pedido.
drop policy if exists "customer uploads own payment proof" on public.payment_proofs;
create policy "customer uploads own payment proof" on public.payment_proofs for insert to authenticated
with check (
  uploaded_by=auth.uid()
  and exists(select 1 from public.transfer_payments tp join public.orders o on o.id=tp.order_id
    where tp.id=payment_id and o.customer_id=auth.uid() and tp.status in ('awaiting_transfer','rejected'))
);

-- Bucket privado. La aplicación debe subir archivos con ruta {user_id}/{payment_id}/{filename}.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('payment-proofs','payment-proofs',false,5242880,array['image/jpeg','image/png','application/pdf'])
on conflict (id) do update set public=false, file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png','application/pdf'];

drop policy if exists "customer uploads own proof files" on storage.objects;
create policy "customer uploads own proof files" on storage.objects for insert to authenticated
with check (
  bucket_id='payment-proofs'
  and (storage.foldername(name))[1]=auth.uid()::text
);
drop policy if exists "related users read proof files" on storage.objects;
create policy "related users read proof files" on storage.objects for select to authenticated
using (
  bucket_id='payment-proofs'
  and (
    (storage.foldername(name))[1]=auth.uid()::text
    or exists(
      select 1 from public.payment_proofs pp
      join public.transfer_payments tp on tp.id=pp.payment_id
      left join public.merchant_orders mo on mo.id=tp.merchant_order_id
      left join public.orders o on o.id=tp.order_id
      where pp.storage_path=name and (
        o.customer_id=auth.uid() or mo.merchant_id=auth.uid()
        or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin')
      )
    )
  )
);

create or replace function public.refresh_merlo_order_payment_status()
returns trigger language plpgsql security definer set search_path=public as $$
declare oid uuid;
begin
  oid := coalesce(new.order_id, old.order_id);
  if exists(select 1 from public.transfer_payments where order_id=oid and status='rejected') then
    update public.orders set status='payment_review', updated_at=now() where id=oid;
  elsif exists(select 1 from public.transfer_payments where order_id=oid and status<>'verified') then
    update public.orders set status='awaiting_transfers', updated_at=now() where id=oid;
  else
    update public.orders set status='confirmed', updated_at=now() where id=oid;
  end if;
  update public.merchant_orders mo
    set status=case
      when exists(select 1 from public.transfer_payments tp where tp.merchant_order_id=mo.id and tp.status='rejected') then 'payment_review'
      when exists(select 1 from public.transfer_payments tp where tp.merchant_order_id=mo.id and tp.status<>'verified') then 'awaiting_transfers'
      else 'confirmed' end
    where mo.order_id=oid;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists transfer_payment_status_refresh on public.transfer_payments;
create trigger transfer_payment_status_refresh
after insert or update of status or delete on public.transfer_payments
for each row execute function public.refresh_merlo_order_payment_status();

create or replace function public.set_merlo_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end; $$;
drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at before update on public.orders
for each row execute function public.set_merlo_updated_at();

-- Tarifas iniciales editables. Se pueden modificar desde el panel admin.
insert into public.delivery_rate_tiers(label,min_km,max_km,fee,sort_order)
select 'Hasta 5 km',0,5,2000,1
where not exists(select 1 from public.delivery_rate_tiers);
insert into public.delivery_rate_tiers(label,min_km,max_km,fee,sort_order)
select 'Más de 5 km',5,null,3000,2
where not exists(select 1 from public.delivery_rate_tiers);

commit;
