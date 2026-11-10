import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Falta autenticación." }, 401);

  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Sesión inválida." }, 401);
  const db = createClient(url, serviceKey);

  try {
    const idempotencyKey = req.headers.get("Idempotency-Key") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return json({ error: "Falta una clave de idempotencia válida para este checkout." }, 400);
    }
    const body = await req.json();
    const address = String(body.delivery_address ?? "").trim();
    const zone = String(body.delivery_zone ?? "").trim();
    const phone = String(body.customer_phone ?? "").trim();
    const lat = Number(body.delivery_latitude);
    const lon = Number(body.delivery_longitude);
    const items: Array<{ product_id: string; quantity: number }> = body.items ?? [];
    if (!address || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180 ||
        !Array.isArray(items) || items.length < 1 || items.length > 80) {
      return json({ error: "Dirección, ubicación y productos son obligatorios." }, 400);
    }
    if (items.some(x => !x.product_id || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 99)) {
      return json({ error: "Hay productos o cantidades inválidas." }, 400);
    }
    const fingerprintPayload = {
      customer_id: user.id, delivery_address: address, delivery_zone: zone,
      customer_phone: phone, delivery_latitude: lat, delivery_longitude: lon,
      items: items.map(x => ({ product_id: x.product_id, quantity: x.quantity }))
        .sort((a, b) => a.product_id.localeCompare(b.product_id) || a.quantity - b.quantity),
    };
    const fingerprintBytes = new TextEncoder().encode(JSON.stringify(fingerprintPayload));
    const fingerprintDigest = await crypto.subtle.digest("SHA-256", fingerprintBytes);
    const requestFingerprint = Array.from(new Uint8Array(fingerprintDigest))
      .map(byte => byte.toString(16).padStart(2, "0")).join("");

    const { data: customer } = await db.from("profiles").select("id,role").eq("id", user.id).maybeSingle();
    if (!customer || customer.role !== "usuario") return json({ error: "La cuenta debe ser de cliente." }, 403);

    const productIds = [...new Set(items.map(x => x.product_id))];
    const { data: products, error: productError } = await db.from("products")
      .select("id,comercio_id,nombre,precio").in("id", productIds);
    if (productError || !products || products.length !== productIds.length) {
      return json({ error: "No se pudieron validar todos los productos." }, 400);
    }
    const grouped = new Map<string, Array<{ product: any; quantity: number }>>();
    for (const item of items) {
      const product = products.find(p => p.id === item.product_id);
      if (!product || Number(product.precio) < 0) return json({ error: "Producto inválido." }, 400);
      const group = grouped.get(product.comercio_id) ?? [];
      group.push({ product, quantity: item.quantity });
      grouped.set(product.comercio_id, group);
    }

    const { data: rates, error: rateError } = await db.from("delivery_rate_tiers")
      .select("id,label,min_km,max_km,fee").eq("active", true).order("sort_order");
    if (rateError || !rates?.length) return json({ error: "Merlo Ya todavía no configuró las tarifas de envío." }, 409);

    const { data: platformAccount } = await db.from("platform_settings")
      .select("account_holder,bank_name,cbu,alias").eq("id", true).maybeSingle();
    if (!platformAccount || (!platformAccount.cbu && !platformAccount.alias)) {
      return json({ error: "Merlo Ya todavía no configuró su cuenta bancaria." }, 409);
    }

    const merchantData = new Map<string, any>();
    for (const merchantId of grouped.keys()) {
      const [{ data: merchant }, { data: bank }] = await Promise.all([
        db.from("profiles").select("id,nombre,latitude,longitude,role").eq("id", merchantId).single(),
        db.from("merchant_payment_accounts").select("account_holder,bank_name,cbu,alias").eq("merchant_id", merchantId).maybeSingle(),
      ]);
      if (!merchant || merchant.role !== "comercio" ||
          merchant.latitude === null || merchant.latitude === undefined ||
          merchant.longitude === null || merchant.longitude === undefined ||
          !Number.isFinite(Number(merchant.latitude)) || !Number.isFinite(Number(merchant.longitude))) {
        return json({ error: `El comercio ${merchant?.nombre ?? ""} todavía no tiene ubicación cargada.` }, 409);
      }
      if (!bank || (!bank.cbu && !bank.alias)) {
        return json({ error: `El comercio ${merchant.nombre} todavía no configuró su cuenta para transferencias.` }, 409);
      }
      merchantData.set(merchantId, { merchant, bank });
    }

    // OSRM calcula recorrido vial. Para producción de alto tráfico, configurar un proveedor con SLA.
    const routeBase = (Deno.env.get("ROUTING_BASE_URL") ?? "https://router.project-osrm.org").replace(/\/$/, "");
    const calculated: Array<any> = [];
    let subtotalTotal = 0, shippingTotal = 0;
    for (const [merchantId, lines] of grouped.entries()) {
      const { merchant, bank } = merchantData.get(merchantId);
      const routeUrl = `${routeBase}/route/v1/driving/${Number(merchant.longitude)},${Number(merchant.latitude)};${lon},${lat}?overview=false`;
      const routeResponse = await fetch(routeUrl);
      if (!routeResponse.ok) return json({ error: "No se pudo calcular el recorrido de uno de los comercios." }, 502);
      const route = await routeResponse.json();
      if (route.code !== "Ok" || !route.routes?.[0]) return json({ error: `No hay recorrido disponible desde ${merchant.nombre}.` }, 422);
      const km = Number(route.routes[0].distance) / 1000;
      const tier = rates.find(r => km >= Number(r.min_km) && (r.max_km === null || km <= Number(r.max_km)));
      if (!tier) return json({ error: `No hay tarifa configurada para ${km.toFixed(1)} km.` }, 409);
      const subtotal = lines.reduce((sum, x) => sum + Number(x.product.precio) * x.quantity, 0);
      subtotalTotal += subtotal; shippingTotal += Number(tier.fee);
      calculated.push({
        merchantId, merchant, bank, lines, subtotal, km, tier,
        shipping: Number(tier.fee), merchantOrderId: crypto.randomUUID(),
      });
    }

    const total = subtotalTotal + shippingTotal;
    // IDs estables para que todas las filas relacionadas se inserten en una única transacción SQL.
    const merchantOrderRows = calculated.map((part) => ({
      id: part.merchantOrderId, merchant_id: part.merchantId, subtotal: part.subtotal,
      route_distance_km: part.km, shipping_fee: part.shipping, delivery_rate_tier_id: part.tier.id,
      delivery_address_snapshot: address, merchant_name_snapshot: part.merchant.nombre,
    }));
    const itemRows = calculated.flatMap((part) => part.lines.map((x: any) => ({
      merchant_order_id: part.merchantOrderId, product_id: x.product.id,
      product_name_snapshot: x.product.nombre, unit_price: Number(x.product.precio), quantity: x.quantity,
    })));
    const paymentRows = calculated.flatMap((part) => [
      { merchant_order_id: part.merchantOrderId, payee_type: "merchant", merchant_id: part.merchantId,
        amount: part.subtotal, destination_snapshot: part.bank },
      { merchant_order_id: part.merchantOrderId, payee_type: "merlo_ya", merchant_id: null,
        amount: part.shipping, destination_snapshot: platformAccount },
    ].filter((payment) => payment.amount > 0));

    const { data: transaction, error: transactionError } = await db.rpc("create_merlo_transfer_order", {
      p_idempotency_key: idempotencyKey,
      p_request_fingerprint: requestFingerprint,
      p_order: {
        customer_id: user.id, delivery_address: address, delivery_zone: zone || null,
        delivery_latitude: lat, delivery_longitude: lon, customer_phone: phone || null,
        subtotal: subtotalTotal, shipping_total: shippingTotal, total_amount: total,
        status: "awaiting_transfers",
      },
      p_merchant_orders: merchantOrderRows,
      p_order_items: itemRows,
      p_transfer_payments: paymentRows,
    });
    if (transactionError) {
      if (transactionError.message?.includes("IDEMPOTENCY_KEY_REUSED")) {
        return json({ error: "La clave de checkout ya fue utilizada con datos diferentes. Iniciá un nuevo checkout." }, 409);
      }
      throw transactionError;
    }
    const orderId = transaction?.order_id;
    if (!orderId) throw new Error("No se pudo confirmar la creación transaccional del pedido.");

    const { data: payments, error: paymentsError } = await db.from("transfer_payments")
      .select("id,merchant_order_id,payee_type,merchant_id,amount,destination_snapshot,status")
      .eq("order_id", orderId);
    if (paymentsError) throw paymentsError;

    let summaries;
    let responseSubtotal = subtotalTotal, responseShipping = shippingTotal, responseTotal = total;
    if (transaction.replayed) {
      const [{ data: savedOrder, error: savedOrderError }, { data: savedMerchants, error: savedMerchantsError }] = await Promise.all([
        db.from("orders").select("subtotal,shipping_total,total_amount").eq("id", orderId).single(),
        db.from("merchant_orders").select("id,subtotal,route_distance_km,shipping_fee,merchant_name_snapshot,delivery_rate_tier_id").eq("order_id", orderId),
      ]);
      if (savedOrderError || savedMerchantsError || !savedOrder || !savedMerchants) {
        throw savedOrderError ?? savedMerchantsError ?? new Error("No se pudo recuperar el pedido existente.");
      }
      const tierIds = [...new Set(savedMerchants.map((x: any) => x.delivery_rate_tier_id).filter(Boolean))];
      const { data: savedTiers, error: savedTiersError } = tierIds.length
        ? await db.from("delivery_rate_tiers").select("id,label").in("id", tierIds)
        : { data: [], error: null };
      if (savedTiersError) throw savedTiersError;
      const tierLabels = new Map((savedTiers ?? []).map((x: any) => [x.id, x.label]));
      summaries = savedMerchants.map((part: any) => ({
        merchant_order_id: part.id, merchant: part.merchant_name_snapshot,
        subtotal: Number(part.subtotal), route_distance_km: Number(Number(part.route_distance_km).toFixed(2)),
        shipping: Number(part.shipping_fee), rate: tierLabels.get(part.delivery_rate_tier_id) ?? "Tarifa aplicada",
      }));
      responseSubtotal = Number(savedOrder.subtotal);
      responseShipping = Number(savedOrder.shipping_total);
      responseTotal = Number(savedOrder.total_amount);
    } else {
      summaries = calculated.map((part) => ({
        merchant_order_id: part.merchantOrderId, merchant: part.merchant.nombre,
        subtotal: part.subtotal, route_distance_km: Number(part.km.toFixed(2)),
        shipping: part.shipping, rate: part.tier.label,
      }));
    }

    return json({ order_id: orderId, replayed: Boolean(transaction.replayed),
      subtotal: responseSubtotal, shipping_total: responseShipping,
      total: responseTotal, merchant_orders: summaries, payments });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Error interno al crear el pedido." }, 500);
  }
});
