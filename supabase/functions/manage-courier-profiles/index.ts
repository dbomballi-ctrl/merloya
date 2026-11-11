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
  const authorization = req.headers.get("Authorization");
  if (!authorization) return json({ error: "No autenticado." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await anon.auth.getUser();
  if (!user) return json({ error: "Sesión inválida." }, 401);
  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const { data: actor, error: actorError } = await db.from("profiles").select("role").eq("id", user.id).single();
    if (actorError || actor?.role !== "admin") return json({ error: "Solo administración puede habilitar repartidores." }, 403);
    const body = await req.json();

    if (body.action === "list") {
      const { data, error } = await db.from("profiles").select("id,nombre,role,is_demo")
        .in("role", ["usuario", "repartidor"]).order("nombre").limit(200);
      if (error) throw error;
      return json({ success: true, profiles: data ?? [] });
    }

    const targetId = String(body.user_id ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
      return json({ error: "Cuenta seleccionada inválida." }, 400);
    }
    const { data: target, error: targetError } = await db.from("profiles").select("id,role").eq("id", targetId).single();
    if (targetError || !target) return json({ error: "No se encontró la cuenta." }, 404);

    if (body.action === "promote") {
      if (target.role !== "usuario") return json({ error: "Solo se pueden habilitar cuentas de cliente." }, 409);
      const { error } = await db.from("profiles").update({ role: "repartidor" }).eq("id", targetId).eq("role", "usuario");
      if (error) throw error;
      return json({ success: true, role: "repartidor" });
    }

    if (body.action === "demote") {
      if (target.role !== "repartidor") return json({ error: "La cuenta no es repartidor." }, 409);
      const { data: active, error: assignmentError } = await db.from("delivery_assignments")
        .select("id").eq("courier_id", targetId).in("status", ["assigned", "picked_up"]).limit(1);
      if (assignmentError) throw assignmentError;
      if (active?.length) return json({ error: "No se puede deshabilitar: tiene entregas activas." }, 409);
      const { error } = await db.from("profiles").update({ role: "usuario" }).eq("id", targetId).eq("role", "repartidor");
      if (error) throw error;
      return json({ success: true, role: "usuario" });
    }

    return json({ error: "Acción desconocida." }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo administrar el perfil." }, 500);
  }
});
