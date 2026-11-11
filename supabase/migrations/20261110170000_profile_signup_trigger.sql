-- Create a matching public profile for every Supabase Auth signup.
-- Public signup may choose customer or merchant only; admin is never client-assignable.
begin;

create or replace function public.handle_merlo_auth_signup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  v_role := case
    when new.raw_user_meta_data->>'role' = 'comercio' then 'comercio'
    else 'usuario'
  end;

  insert into public.profiles (
    id, nombre, rubro, domicilio, zona, whatsapp, role
  ) values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'nombre'), ''), split_part(coalesce(new.email, ''), '@', 1)),
    nullif(trim(new.raw_user_meta_data->>'rubro'), ''),
    nullif(trim(new.raw_user_meta_data->>'domicilio'), ''),
    nullif(trim(new.raw_user_meta_data->>'zona'), ''),
    nullif(trim(new.raw_user_meta_data->>'whatsapp'), ''),
    v_role
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_merlo_auth_user_created on auth.users;
create trigger on_merlo_auth_user_created
after insert on auth.users
for each row execute function public.handle_merlo_auth_signup();

revoke all on function public.handle_merlo_auth_signup() from public, anon, authenticated;

commit;
