import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
    const body = await req.json();
    const idempotencyKey = String(body.idempotency_key ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return json({ error: "La clave de pedido no es válida. Recargá el checkout e intentá nuevamente." }, 400);
    }
    const fulfillmentType = String(body.fulfillment_type ?? "delivery");
    if (!["delivery", "pickup"].includes(fulfillmentType)) {
      return json({ error: "Modalidad de entrega inválida." }, 400);
    }
    const address = fulfillmentType === "pickup"
      ? "Retiro en comercio"
      : String(body.delivery_address ?? "").trim();
    const zone = String(body.delivery_zone ?? "").trim();
    const phone = String(body.customer_phone ?? "").trim();
    const lat = body.delivery_latitude == null ? null : Number(body.delivery_latitude);
    const lon = body.delivery_longitude == null ? null : Number(body.delivery_longitude);
    const items: Array<{ product_id: string; quantity: number }> = body.items ?? [];
    const invalidDeliveryLocation = fulfillmentType === "delivery" &&
      (!address || lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon) ||
       lat < -90 || lat > 90 || lon < -180 || lon > 180);
    if (invalidDeliveryLocation || !Array.isArray(items) || items.length < 1 || items.length > 80) {
      return json({ error: fulfillmentType === "delivery"
        ? "Dirección, ubicación y productos son obligatorios."
        : "El carrito no contiene productos válidos." }, 400);
    }
    if (items.some(x => !x.product_id || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 99)) {
      return json({ error: "Hay productos o cantidades inválidas." }, 400);
    }

    const { data: customer } = await db.from("profiles").select("id,role").eq("id", user.id).maybeSingle();
    if (!customer || customer.role !== "usuario") return json({ error: "La cuenta debe ser de cliente." }, 403);

    const productIds = [...new Set(items.map(x => x.product_id))];
    const { data: products, error: productError } = await db.from("products")
      .select("id,comercio_id,nombre,precio,is_demo,publication_status").in("id", productIds);
    if (productError || !products || products.length !== productIds.length || products.some(p => p.publication_status !== "approved")) {
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

    let rates: any[] = [];
    let platformAccount: any = null;
    if (fulfillmentType === "delivery") {
      const { data, error: rateError } = await db.from("delivery_rate_tiers")
        .select("id,label,min_km,max_km,fee").eq("active", true).order("sort_order");
      if (rateError || !data?.length) return json({ error: "Merlo Ya todavía no configuró las tarifas de envío." }, 409);
      rates = data;

      const { data: account } = await db.from("platform_settings")
        .select("account_holder,bank_name,cbu,alias").eq("id", true).maybeSingle();
      if (!account || (!account.cbu && !account.alias)) {
        return json({ error: "Merlo Ya todavía no configuró su cuenta bancaria." }, 409);
      }
      platformAccount = account;
    }

    const merchantData = new Map<string, any>();
    for (const merchantId of grouped.keys()) {
      const [{ data: merchant }, { data: bank }] = await Promise.all([
        db.from("profiles").select("id,nombre,domicilio,zona,latitude,longitude,role,is_demo,publication_status").eq("id", merchantId).single(),
        db.from("merchant_payment_accounts").select("account_holder,bank_name,cbu,alias").eq("merchant_id", merchantId).maybeSingle(),
      ]);
      if (!merchant || merchant.role !== "comercio" || merchant.publication_status !== "approved") {
        return json({ error: "Uno de los comercios no está disponible para recibir pedidos." }, 409);
      }
      if (fulfillmentType === "delivery" && (
          merchant.latitude === null || merchant.latitude === undefined ||
          merchant.longitude === null || merchant.longitude === undefined ||
          !Number.isFinite(Number(merchant.latitude)) || !Number.isFinite(Number(merchant.longitude)))) {
        return json({ error: `El comercio ${merchant.nombre} todavía no tiene ubicación cargada.` }, 409);
      }
      if (fulfillmentType === "pickup" && !String(merchant.domicilio ?? "").trim()) {
        return json({ error: `El comercio ${merchant.nombre} todavía no informó dónde retirar.` }, 409);
      }
      if (!bank || (!bank.cbu && !bank.alias)) {
        return json({ error: `El comercio ${merchant.nombre} todavía no configuró su cuenta para transferencias.` }, 409);
      }
      merchantData.set(merchantId, { merchant, bank });
    }

    const demoMode = products.every(p => p.is_demo === true) && [...merchantData.values()].every(x => x.merchant.is_demo === true);

    // OSRM calcula recorrido vial. Para producción de alto tráfico, configurar un proveedor con SLA.
    const routeBase = (Deno.env.get("ROUTING_BASE_URL") ?? "https://router.project-osrm.org").replace(/\/$/, "");
    const calculated: Array<any> = [];
    let subtotalTotal = 0, shippingTotal = 0;
    for (const [merchantId, lines] of grouped.entries()) {
      const { merchant, bank } = merchantData.get(merchantId);
      let km = 0;
      let tier: any = null;
      let shipping = 0;
      if (fulfillmentType === "delivery") {
        const routeUrl = `${routeBase}/route/v1/driving/${Number(merchant.longitude)},${Number(merchant.latitude)};${lon},${lat}?overview=false`;
        const routeResponse = await fetch(routeUrl);
        if (!routeResponse.ok) return json({ error: "No se pudo calcular el recorrido de uno de los comercios." }, 502);
        const route = await routeResponse.json();
        if (route.code !== "Ok" || !route.routes?.[0]) return json({ error: `No hay recorrido disponible desde ${merchant.nombre}.` }, 422);
        km = Number(route.routes[0].distance) / 1000;
        tier = rates.find(r => km >= Number(r.min_km) && (r.max_km === null || km <= Number(r.max_km)));
        if (!tier) return json({ error: `No hay tarifa configurada para ${km.toFixed(1)} km.` }, 409);
        shipping = Number(tier.fee);
      }
      const subtotal = lines.reduce((sum, x) => sum + Number(x.product.precio) * x.quantity, 0);
      subtotalTotal += subtotal; shippingTotal += shipping;
      calculated.push({ merchantId, merchant, bank, lines, subtotal, km, tier, shipping });
    }

    const total = subtotalTotal + shippingTotal;
    const merchantOrderRows: any[] = [];
    const itemRows: any[] = [];
    const obligations: any[] = [];
    const summaries: any[] = [];
    for (const part of calculated) {
      const merchantOrderId = crypto.randomUUID();
      merchantOrderRows.push({
        id: merchantOrderId, merchant_id: part.merchantId, subtotal: part.subtotal,
        route_distance_km: part.km, shipping_fee: part.shipping,
        delivery_rate_tier_id: part.tier?.id ?? null,
        delivery_address_snapshot: fulfillmentType === "pickup"
          ? String(part.merchant.domicilio ?? part.merchant.zona ?? "").trim()
          : address,
        merchant_name_snapshot: part.merchant.nombre,
      });
      for (const x of part.lines) {
        itemRows.push({
          merchant_order_id: merchantOrderId, product_id: x.product.id,
          product_name_snapshot: x.product.nombre, unit_price: Number(x.product.precio),
          quantity: x.quantity,
        });
      }
      const destinations = [
        { payee_type: "merchant", merchant_id: part.merchantId, amount: part.subtotal, destination_snapshot: part.bank },
        { payee_type: "merlo_ya", merchant_id: null, amount: part.shipping, destination_snapshot: platformAccount },
      ];
      for (const d of destinations) {
        if (!demoMode && d.amount > 0) obligations.push({
          merchant_order_id: merchantOrderId, payee_type: d.payee_type,
          merchant_id: d.merchant_id, amount: d.amount, destination_snapshot: d.destination_snapshot,
        });
      }
      summaries.push({
        merchant_order_id: merchantOrderId, merchant: part.merchant.nombre,
        subtotal: part.subtotal, route_distance_km: Number(part.km.toFixed(2)),
        shipping: part.shipping, rate: part.tier?.label ?? "Retiro gratuito",
        pickup_address: fulfillmentType === "pickup"
          ? String(part.merchant.domicilio ?? part.merchant.zona ?? "").trim()
          : null,
      });
    }

    const fingerprintPayload = {
      customer_id: user.id, fulfillment_type: fulfillmentType,
      delivery_address: address, delivery_zone: zone || null,
      customer_phone: phone || null, delivery_latitude: lat, delivery_longitude: lon,
      items: items.map(x => ({ product_id: x.product_id, quantity: x.quantity }))
        .sort((a, b) => a.product_id.localeCompare(b.product_id)),
    };
    const fingerprintBytes = await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(JSON.stringify(fingerprintPayload)),
    );
    const requestFingerprint = Array.from(new Uint8Array(fingerprintBytes))
      .map(x => x.toString(16).padStart(2, "0")).join("");

    const { data: created, error: createError } = await db.rpc("create_merlo_transfer_order", {
      p_idempotency_key: idempotencyKey,
      p_request_fingerprint: requestFingerprint,
      p_order: {
        customer_id: user.id, fulfillment_type: fulfillmentType,
        delivery_address: address, delivery_zone: zone || null,
        delivery_latitude: lat, delivery_longitude: lon, customer_phone: phone || null,
        subtotal: subtotalTotal, shipping_total: shippingTotal, total_amount: total,
        status: demoMode ? "confirmed" : "awaiting_transfers",
        is_demo: demoMode,
      },
      p_merchant_orders: merchantOrderRows,
      p_order_items: itemRows,
      p_transfer_payments: obligations,
    });
    if (createError || !created?.order_id) {
      if (createError?.message?.includes("IDEMPOTENCY_KEY_REUSED")) {
        return json({ error: "La clave de compra ya se usó con otros datos. Volvé a iniciar el checkout." }, 409);
      }
      throw createError ?? new Error("No se pudo crear el pedido.");
    }
    const orderId = created.order_id;
    const replayed = created.replayed === true;
    if (demoMode) {
      const { error: demoStatusError } = await db.from("merchant_orders")
        .update({ status: "confirmed" }).eq("order_id", orderId).eq("status", "awaiting_transfers");
      if (demoStatusError) throw demoStatusError;
    }
    const { data: payments, error: paymentError } = await db.from("transfer_payments")
      .select("id,merchant_order_id,payee_type,merchant_id,amount,destination_snapshot,status")
      .eq("order_id", orderId).order("created_at", { ascending: true });
    if (paymentError) throw paymentError;

    // WhatsApp se abre mediante un enlace wa.me: el cliente confirma el envío manualmente.
    const pickupDetails = fulfillmentType === "pickup"
      ? calculated.map(part => `• ${part.merchant.nombre}: ${part.merchant.domicilio || part.merchant.zona || "Dirección a coordinar"}`).join("\n")
      : "";
    const whatsappMessage =
      `🛒 NUEVO PEDIDO - MERLO YA\n\n` +
      `📦 Pedido: ${orderId}\n` +
      `💰 Total: ${total.toFixed(2)}\n` +
      `🚚 Modalidad: ${fulfillmentType === "pickup" ? "Retiro gratuito en comercio" : "Delivery Merlo Ya"}\n` +
      (fulfillmentType === "pickup" ? `🏪 Retirar en:\n${pickupDetails}\n` : `📍 Dirección: ${address}\n`) +
      `📱 Cliente: ${phone || "No informado"}\n` +
      (demoMode ? `🧪 PEDIDO DE PRUEBA - no transferir dinero` : `💳 Estado: Esperando transferencias`);
    const whatsappUrl = `https://wa.me/5491126306785?text=${encodeURIComponent(whatsappMessage)}`;

return json({
  order_id: orderId,
  fulfillment_type: fulfillmentType,
  subtotal: subtotalTotal,
  shipping_total: shippingTotal,
  total,
  merchant_orders: summaries,
  payments,
  whatsapp_url: whatsappUrl,
  demo_mode: demoMode
});

  } catch (error) {
    console.error(error);
    return json({
      error: error instanceof Error
        ? error.message
        : "Error interno al crear el pedido."
    }, 500);
  }
});

