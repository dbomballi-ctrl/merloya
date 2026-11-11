-- Restore only the public merchant profile columns needed by the security-invoker catalog view.
-- RLS on profiles restricts anon/authenticated rows to approved merchants or the caller's own profile.
GRANT SELECT (id, nombre, rubro, zona, store_image_url, is_demo, publication_status, role, domicilio)
  ON TABLE public.profiles TO anon, authenticated;
