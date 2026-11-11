-- Public catalog access is read-only. Remove inherited broad grants from anon.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
GRANT SELECT ON TABLE public.products, public.public_merchants TO anon;
