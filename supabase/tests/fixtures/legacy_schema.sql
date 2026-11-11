-- Minimal legacy schema fixture for isolated local migration tests.
-- This is test-only: it is never applied to the hosted Supabase project.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  domicilio text,
  whatsapp text,
  zona text,
  rubro text,
  role text default 'usuario' check (role = any (array['usuario'::text, 'comercio'::text, 'admin'::text])),
  created_at timestamptz not null default timezone('utc'::text, now())
);
alter table public.profiles enable row level security;

-- Seed the demo merchant identity expected by the demo catalog migration.
insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'b599b569-2cf5-4f1d-aa4a-ebe369ff57d8',
  'authenticated', 'authenticated', 'demo-merchant@merloya.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
) on conflict (id) do nothing;

insert into public.profiles (id, nombre, domicilio, zona, rubro, role)
values (
  'b599b569-2cf5-4f1d-aa4a-ebe369ff57d8',
  'Almacén El Colibrí · DEMO',
  'Av. Del Sol de Prueba',
  'Centro · Villa de Merlo',
  'Almacenes',
  'comercio'
) on conflict (id) do nothing;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  comercio_id uuid references public.profiles(id),
  nombre text not null,
  precio numeric not null,
  created_at timestamptz not null default timezone('utc'::text, now())
);
alter table public.products enable row level security;

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  comercio_id uuid not null references public.profiles(id),
  usuario_id uuid references public.profiles(id),
  monto_total numeric not null,
  comision_admin numeric not null,
  created_at timestamptz not null default timezone('utc'::text, now())
);
alter table public.sales enable row level security;
