-- Structural/security smoke tests for the eight Merlo Ya 2.0 migrations.
do $$
declare
  v_constraint text;
  v_options text[];
begin
  if to_regclass('public.orders') is null
     or to_regclass('public.merchant_orders') is null
     or to_regclass('public.transfer_payments') is null
     or to_regclass('public.delivery_assignments') is null
     or to_regclass('public.checkout_idempotency') is null then
    raise exception 'Missing expected Merlo Ya 2.0 tables';
  end if;

  if to_regclass('public.public_merchants') is null then
    raise exception 'Missing public_merchants view';
  end if;
  select reloptions into v_options from pg_class where oid='public.public_merchants'::regclass;
  if not coalesce(v_options @> array['security_invoker=true'], false) then
    raise exception 'public_merchants must use security_invoker=true';
  end if;

  select pg_get_constraintdef(oid) into v_constraint
  from pg_constraint
  where conrelid='public.profiles'::regclass and conname='profiles_role_check';
  if v_constraint is null or position('repartidor' in v_constraint)=0 then
    raise exception 'profiles_role_check does not include repartidor';
  end if;

  if not (select relrowsecurity from pg_class where oid='public.checkout_idempotency'::regclass) then
    raise exception 'checkout_idempotency RLS is not enabled';
  end if;

  if has_table_privilege('anon','public.profiles','SELECT') then
    raise exception 'anon unexpectedly has table-wide SELECT on profiles';
  end if;
  if not has_column_privilege('anon','public.profiles','domicilio','SELECT') then
    raise exception 'anon cannot read approved merchant pickup address';
  end if;
  if position('domicilio' in pg_get_viewdef('public.public_merchants'::regclass,true)) = 0 then
    raise exception 'public_merchants does not expose approved merchant pickup address';
  end if;
  if has_column_privilege('anon','public.profiles','nombre','SELECT') is not true then
    raise exception 'anon cannot read public merchant name';
  end if;
  if has_table_privilege('authenticated','public.sales','INSERT')
     or has_table_privilege('anon','public.sales','SELECT') then
    raise exception 'legacy sales grants are too broad';
  end if;

  if has_table_privilege('anon','public.orders','SELECT')
     or has_table_privilege('anon','public.merchant_orders','SELECT')
     or has_table_privilege('anon','public.transfer_payments','SELECT')
     or has_table_privilege('anon','public.payment_proofs','SELECT')
     or has_table_privilege('anon','public.merchant_payment_accounts','SELECT')
     or has_table_privilege('anon','public.platform_settings','SELECT')
     or has_table_privilege('anon','public.delivery_assignments','SELECT') then
    raise exception 'anon unexpectedly has access to private commerce tables';
  end if;

  if has_function_privilege('authenticated',
       'public.create_merlo_transfer_order(uuid,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE') then
    raise exception 'authenticated can execute privileged checkout RPC';
  end if;
  if not has_function_privilege('service_role',
       'public.create_merlo_transfer_order(uuid,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE') then
    raise exception 'service_role cannot execute checkout RPC';
  end if;
end $$;
