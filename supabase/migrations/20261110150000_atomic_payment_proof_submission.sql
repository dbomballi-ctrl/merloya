-- Register a payment proof and change payment status atomically.
begin;

create or replace function public.register_merlo_payment_proof(
  p_payment_id uuid,
  p_storage_path text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_order_id uuid;
  v_status text;
begin
  if p_payment_id is null or p_actor_id is null
     or p_storage_path is null
     or p_storage_path !~ ('^' || p_actor_id::text || '/' || p_payment_id::text || '/[^/]+$') then
    raise exception 'Invalid proof payload';
  end if;

  select tp.order_id, tp.status into v_order_id, v_status
  from public.transfer_payments tp
  join public.orders o on o.id = tp.order_id
  where tp.id = p_payment_id and o.customer_id = p_actor_id
  for update of tp;

  if not found then
    raise exception 'PAYMENT_NOT_OWNED' using errcode = '42501';
  end if;
  if v_status = 'proof_submitted' and exists (
    select 1 from public.payment_proofs pp
    where pp.payment_id = p_payment_id and pp.storage_path = p_storage_path
      and pp.uploaded_by = p_actor_id
  ) then
    return jsonb_build_object('status', 'proof_submitted', 'order_id', v_order_id, 'replayed', true);
  end if;
  if v_status not in ('awaiting_transfer', 'rejected') then
    raise exception 'PAYMENT_NOT_ACCEPTING_PROOF' using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'payment-proofs' and so.name = p_storage_path
  ) then
    raise exception 'PROOF_FILE_NOT_FOUND' using errcode = '22023';
  end if;

  insert into public.payment_proofs(payment_id, storage_path, uploaded_by)
  values (p_payment_id, p_storage_path, p_actor_id);

  update public.transfer_payments
  set status = 'proof_submitted', reviewed_by = null, reviewed_at = null, review_note = null
  where id = p_payment_id;

  return jsonb_build_object('status', 'proof_submitted', 'order_id', v_order_id);
end;
$$;

revoke all on function public.register_merlo_payment_proof(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.register_merlo_payment_proof(uuid, text, uuid)
  to service_role;

commit;
