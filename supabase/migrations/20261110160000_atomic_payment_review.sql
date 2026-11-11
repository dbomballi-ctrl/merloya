-- Serialize payment review and enforce role/ownership at the database boundary.
begin;

create or replace function public.review_merlo_transfer_payment(
  p_payment_id uuid,
  p_decision text,
  p_note text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payee_type text;
  v_merchant_id uuid;
  v_status text;
  v_role text;
begin
  if p_payment_id is null or p_actor_id is null
     or p_decision not in ('verified', 'rejected') then
    raise exception 'Invalid payment review payload';
  end if;

  select role into v_role from public.profiles where id = p_actor_id;
  select payee_type, merchant_id, status
    into v_payee_type, v_merchant_id, v_status
  from public.transfer_payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_REVIEWABLE' using errcode = '22023';
  end if;
  if v_role is distinct from 'admin'
     and not (v_role = 'comercio' and v_payee_type = 'merchant' and v_merchant_id = p_actor_id) then
    raise exception 'PAYMENT_REVIEW_FORBIDDEN' using errcode = '42501';
  end if;
  if v_status <> 'proof_submitted' then
    raise exception 'PAYMENT_NOT_REVIEWABLE' using errcode = '22023';
  end if;

  update public.transfer_payments
  set status = p_decision, reviewed_by = p_actor_id,
      reviewed_at = now(), review_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_payment_id;

  return jsonb_build_object('payment_id', p_payment_id, 'status', p_decision);
end;
$$;

revoke all on function public.review_merlo_transfer_payment(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.review_merlo_transfer_payment(uuid, text, text, uuid)
  to service_role;

commit;
