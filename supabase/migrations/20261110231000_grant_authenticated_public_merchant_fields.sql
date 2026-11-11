-- Merchant storefront image is public catalog data; allow authenticated users to read it.
-- Merchant contact numbers remain private to the owning account and admin workflow.
grant select (store_image_url, is_demo, publication_status) on table public.profiles to authenticated;
