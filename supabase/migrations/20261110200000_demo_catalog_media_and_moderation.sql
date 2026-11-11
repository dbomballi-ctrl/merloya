-- Photo catalog, demo marker and merchant moderation.
alter table public.profiles add column if not exists store_image_url text, add column if not exists publication_status text not null default 'approved', add column if not exists is_demo boolean not null default false;
alter table public.products add column if not exists image_url text, add column if not exists description text, add column if not exists publication_status text not null default 'approved', add column if not exists is_demo boolean not null default false;
alter table public.orders add column if not exists is_demo boolean not null default false;
alter table public.profiles drop constraint if exists profiles_publication_status_check;
alter table public.profiles add constraint profiles_publication_status_check check(publication_status in ('pending','approved','rejected'));
alter table public.products drop constraint if exists products_publication_status_check;
alter table public.products add constraint products_publication_status_check check(publication_status in ('pending','approved','rejected'));
drop policy if exists "Productos visibles para todos" on public.products;
create policy "Public can read approved products" on public.products for select to anon,authenticated using(publication_status='approved');
drop policy if exists "merchants read own products" on public.products;
create policy "merchants read own products" on public.products for select to authenticated using(comercio_id=auth.uid());
drop policy if exists "admins read all products" on public.products;
create policy "admins read all products" on public.products for select to authenticated using(public.merlo_is_current_user_admin());
drop policy if exists "merchants insert own products" on public.products;
create policy "merchants insert own products" on public.products for insert to authenticated with check(auth.uid()=comercio_id and publication_status='pending' and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='comercio'));
drop policy if exists "merchants update own products" on public.products;
create policy "merchants update own products" on public.products for update to authenticated using(auth.uid()=comercio_id and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='comercio')) with check(auth.uid()=comercio_id and publication_status='pending' and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='comercio'));
create table if not exists public.merchant_profile_submissions(id uuid primary key default gen_random_uuid(),merchant_id uuid not null references public.profiles(id) on delete cascade,proposed_data jsonb not null,status text not null default 'pending' check(status in ('pending','approved','rejected')),review_note text,reviewed_by uuid references public.profiles(id),reviewed_at timestamptz,created_at timestamptz not null default now());
alter table public.merchant_profile_submissions enable row level security;
drop policy if exists "merchant submits own profile changes" on public.merchant_profile_submissions;
create policy "merchant submits own profile changes" on public.merchant_profile_submissions for insert to authenticated with check(merchant_id=auth.uid() and status='pending' and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='comercio'));
drop policy if exists "merchant reads own profile submissions" on public.merchant_profile_submissions;
create policy "merchant reads own profile submissions" on public.merchant_profile_submissions for select to authenticated using(merchant_id=auth.uid());
drop policy if exists "admin reads profile submissions" on public.merchant_profile_submissions;
create policy "admin reads profile submissions" on public.merchant_profile_submissions for select to authenticated using(public.merlo_is_current_user_admin());
create or replace view public.public_merchants with (security_invoker=true) as select id,nombre,rubro,zona,store_image_url,is_demo from public.profiles where role='comercio' and publication_status='approved';
update public.profiles set nombre='Almacén El Colibrí · DEMO',rubro='Almacenes',zona='Centro · Villa de Merlo',store_image_url='https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1200&q=85',publication_status='approved',is_demo=true where id='b599b569-2cf5-4f1d-aa4a-ebe369ff57d8';
delete from public.products where comercio_id='b599b569-2cf5-4f1d-aa4a-ebe369ff57d8';
insert into public.products(comercio_id,nombre,precio,image_url,description,publication_status,is_demo) values
('b599b569-2cf5-4f1d-aa4a-ebe369ff57d8','Yerba mate 1 kg',5200,'https://images.unsplash.com/photo-1556679343-c7306c1976bc?auto=format&fit=crop&w=900&q=85','Yerba mate para todos los días.','approved',true),
('b599b569-2cf5-4f1d-aa4a-ebe369ff57d8','Pan de campo',3800,'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=900&q=85','Pan artesanal recién horneado.','approved',true),
('b599b569-2cf5-4f1d-aa4a-ebe369ff57d8','Café molido 250 g',4600,'https://images.unsplash.com/photo-1559056199-641a0ac8b427?auto=format&fit=crop&w=900&q=85','Café tostado y molido.','approved',true),
('b599b569-2cf5-4f1d-aa4a-ebe369ff57d8','Aceite de oliva 500 ml',8900,'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=900&q=85','Aceite de oliva extra virgen.','approved',true),
('b599b569-2cf5-4f1d-aa4a-ebe369ff57d8','Miel serrana 500 g',6500,'https://images.unsplash.com/photo-1587049352851-8d4e89133924?auto=format&fit=crop&w=900&q=85','Miel regional.','approved',true),
('b599b569-2cf5-4f1d-aa4a-ebe369ff57d8','Dulce de leche 400 g',4200,'https://images.unsplash.com/photo-1488477181946-6428a0291777?auto=format&fit=crop&w=900&q=85','Dulce de leche clásico.','approved',true)
on conflict do nothing;