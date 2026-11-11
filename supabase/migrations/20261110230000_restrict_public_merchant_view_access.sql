-- Restrict the public merchant view to read-only access.
revoke insert, update, delete, truncate, references, trigger on table public.public_merchants from anon, authenticated;
grant select on table public.public_merchants to anon, authenticated;

-- The view is security_invoker and exposes only the explicit public merchant columns.
-- Keep base-table access limited to those columns for anonymous catalog reads.
revoke all on table public.profiles from anon;
grant select (id, nombre, rubro, zona, store_image_url, is_demo, publication_status, role)
  on table public.profiles to anon;
