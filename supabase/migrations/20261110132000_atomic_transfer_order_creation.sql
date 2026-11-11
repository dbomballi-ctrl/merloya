-- Atomic checkout: the order, merchant suborders, items and transfer obligations
-- are committed together or rolled back together. This file is source-only until
-- explicitly reviewed and deployed by an authorized operator.
begin;

create or replace function public.create_merlo_transfer_order(
  p_order jsonb,
  p_merchant_orders jsonb,
  p_order_items jsonb,
  p_transfer_payments jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
begin
  if jsonb_typeof(p_order) <> 'object'
     or jsonb_typeof(p_merchant_orders) <> 'array'
     or jsonb_array_length(p_merchant_orders) = 0
     or jsonb_typeof(p_order_items) <> 'array'
     or jsonb_array_length(p_order_items) = 0
     or jsonb_typeof(p_transfer_payments) <> 'array'
     or jsonb_array_length(p_transfer_payments) = 0 then
    raise exception 'Invalid checkout payload';
  end if;

  insert into public.orders (
    customer_id, delivery_address, delivery_zone, delivery_latitude,
    delivery_longitude, customer_phone, subtotal, shipping_total,
    total_amount, status
  ) values (
    (p_order->>'customer_id')::uuid,
    nullif(trim(p_order->>'delivery_address'), ''),
    nullif(trim(p_order->>'delivery_zone'), ''),
    (p_order->>'delivery_latitude')::double precision,
    (p_order->>'delivery_longitude')::double precision,
    nullif(trim(p_order->>'customer_phone'), ''),
    (p_order->>'subtotal')::numeric,
    (p_order->>'shipping_total')::numeric,
    (p_order->>'total_amount')::numeric,
    coalesce(nullif(p_order->>'status', ''), 'awaiting_transfers')
  ) returning id into v_order_id;

  insert into public.merchant_orders (
    id, order_id, merchant_id, subtotal, route_distance_km, shipping_fee,
    delivery_rate_tier_id, delivery_address_snapshot, merchant_name_snapshot
  )
  select x.id, v_order_id, x.merchant_id, x.subtotal, x.route_distance_km,
         x.shipping_fee, x.delivery_rate_tier_id, x.delivery_address_snapshot,
         x.merchant_name_snapshot
  from jsonb_to_recordset(p_merchant_orders) as x(
    id uuid, merchant_id uuid, subtotal numeric, route_distance_km numeric,
    shipping_fee numeric, delivery_rate_tier_id uuid,
    delivery_address_snapshot text, merchant_name_snapshot text
  );

  insert into public.order_items (
    merchant_order_id, product_id, product_name_snapshot, unit_price, quantity
  )
  select x.merchant_order_id, x.product_id, x.product_name_snapshot, x.unit_price, x.quantity
  from jsonb_to_recordset(p_order_items) as x(
    merchant_order_id uuid, product_id uuid, product_name_snapshot text,
    unit_price numeric, quantity integer
  );

  insert into public.transfer_payments (
    order_id, merchant_order_id, payee_type, merchant_id, amount, destination_snapshot
  )
  select v_order_id, x.merchant_order_id, x.payee_type, x.merchant_id,
         x.amount, x.destination_snapshot
  from jsonb_to_recordset(p_transfer_payments) as x(
    merchant_order_id uuid, payee_type text, merchant_id uuid,
    amount numeric, destination_snapshot jsonb
  );

  return v_order_id;
end;
$$;

revoke all on function public.create_merlo_transfer_order(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_merlo_transfer_order(jsonb, jsonb, jsonb, jsonb) to service_role;

commit;
