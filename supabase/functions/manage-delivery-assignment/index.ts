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
  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "No autenticado." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await anon.auth.getUser();
  if (!user) return json({ error: "Sesión inválida." }, 401);
  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const { data: profile, error: profileError } = await db.from("profiles").select("role").eq("id", user.id).single();
    if (profileError || !profile) return json({ error: "Perfil inexistente." }, 403);
    const body = await req.json();

    if (body.action === "assign") {
      if (profile.role !== "admin") return json({ error: "Solo administración puede asignar repartidores." }, 403);
      const orderId = String(body.order_id ?? "");
      const courierId = String(body.courier_id ?? "");
      if (!orderId || !courierId) return json({ error: "Falta el pedido o el repartidor." }, 400);

      const [{ data: order, error: orderError }, { data: courier, error: courierError }] = await Promise.all([
        db.from("orders").select("id,status,fulfillment_type").eq("id", orderId).single(),
        db.from("profiles").select("id,role").eq("id", courierId).single(),
      ]);
      if (orderError || !order) return json({ error: "Pedido inexistente." }, 404);
      if (order.status !== "confirmed") return json({ error: "Solo se pueden asignar pedidos con todos los pagos confirmados." }, 409);
      if (order.fulfillment_type !== "delivery") return json({ error: "Los pedidos con retiro en comercio no requieren repartidor." }, 409);
      if (courierError || courier?.role !== "repartidor") return json({ error: "La cuenta seleccionada no es un repartidor habilitado." }, 400);

      const { data: existing } = await db.from("delivery_assignments").select("id,status").eq("order_id", orderId).maybeSingle();
      if (existing && ["picked_up", "delivered"].includes(existing.status)) {
        return json({ error: "El pedido ya fue retirado o entregado y no puede reasignarse." }, 409);
      }
      const { data: assignment, error } = await db.from("delivery_assignments").upsert({
        order_id: orderId, courier_id: courierId, assigned_by: user.id,
        status: "assigned", assigned_at: new Date().toISOString(),
        picked_up_at: null, delivered_at: null,
      }, { onConflict: "order_id" }).select("id,order_id,courier_id,status,assigned_at").single();
      if (error) throw error;
      return json({ success: true, assignment });
    }

    if (body.action === "update_status") {
      if (profile.role !== "repartidor") return json({ error: "Solo el repartidor asignado puede actualizar la entrega." }, 403);
      const orderId = String(body.order_id ?? "");
      const nextStatus = String(body.status ?? "");
      if (!orderId || !["picked_up", "delivered"].includes(nextStatus)) return json({ error: "Estado de entrega inválido." }, 400);
      const { data: updated, error: updateError } = await db.rpc("update_merlo_delivery_status", {
        p_order_id: orderId, p_next_status: nextStatus, p_actor_id: user.id,
      });
      if (updateError) {
        if (updateError.message?.includes("DELIVERY_STATUS_CONFLICT")) {
          return json({ error: "La entrega cambió de estado o la transición no está permitida." }, 409);
        }
        if (updateError.message?.includes("DELIVERY_UPDATE_FORBIDDEN") ||
            updateError.message?.includes("DELIVERY_ASSIGNMENT_NOT_OWNED")) {
          return json({ error: "No tenés permiso para actualizar esta entrega." }, 403);
        }
        throw updateError;
      }
      return json({ success: true, assignment: updated });
    }

    return json({ error: "Acción desconocida." }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo actualizar la entrega." }, 500);
  }
});
