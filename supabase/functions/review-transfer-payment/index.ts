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
    const { payment_id, decision, note } = await req.json();
    if (!payment_id || !["verified", "rejected"].includes(decision)) {
      return json({ error: "Datos de revisión inválidos." }, 400);
    }
    const { data: result, error: reviewError } = await db.rpc("review_merlo_transfer_payment", {
      p_payment_id: payment_id,
      p_decision: decision,
      p_note: String(note ?? "").slice(0, 500) || null,
      p_actor_id: user.id,
    });
    if (reviewError) {
      if (reviewError.message?.includes("PAYMENT_NOT_REVIEWABLE")) {
        return json({ error: "El pago ya no está pendiente de revisión." }, 409);
      }
      if (reviewError.message?.includes("PAYMENT_REVIEW_FORBIDDEN")) {
        return json({ error: "No tenés permisos para verificar esta transferencia." }, 403);
      }
      throw reviewError;
    }
    return json({ success: true, payment_id, status: result?.status ?? decision });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo revisar el pago." }, 500);
  }
});
