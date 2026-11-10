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
