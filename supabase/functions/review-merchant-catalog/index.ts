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
  const { data: admin } = await db.from("profiles").select("role").eq("id", user.id).single();
  if (admin?.role !== "admin") return json({ error: "Solo Merlo Ya puede aprobar publicaciones." }, 403);

  try {
    const body = await req.json();
    const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : null;
    if (!decision) return json({ error: "Decisión inválida." }, 400);
    const note = String(body.note ?? "").slice(0, 500) || null;
    if (body.kind === "product") {
      const { data, error } = await db.from("products").update({ publication_status: decision })
        .eq("id", body.id).eq("publication_status", "pending")
        .select("id,publication_status").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "El producto ya fue revisado o no existe." }, 404);
      return json({ success: true, item: data });
    }
    if (body.kind === "profile") {
      const { data: submission, error: fetchError } = await db.from("merchant_profile_submissions")
        .select("id,merchant_id,proposed_data,status").eq("id", body.id).eq("status", "pending").single();
      if (fetchError || !submission) return json({ error: "La solicitud ya fue revisada o no existe." }, 404);
      if (decision === "approved") {
        const p = submission.proposed_data ?? {};
        const allowed: Record<string, unknown> = {
          nombre: String(p.nombre ?? "").trim().slice(0, 120),
          rubro: String(p.rubro ?? "").trim().slice(0, 80),
          zona: String(p.zona ?? "").trim().slice(0, 120),
          domicilio: String(p.domicilio ?? "").trim().slice(0, 250) || null,
          store_image_url: String(p.store_image_url ?? "").trim().slice(0, 1000) || null,
          whatsapp: String(p.whatsapp ?? "").trim().slice(0, 40) || null,
          publication_status: "approved",
        };
        if (allowed.store_image_url && !String(allowed.store_image_url).startsWith("https://")) return json({ error: "La imagen debe usar HTTPS." }, 400);
        if (!allowed.nombre || !allowed.rubro) return json({ error: "La solicitud no contiene nombre y rubro válidos." }, 400);
        if (p.requested_role === "comercio") allowed.role = "comercio";
        const { error: profileError } = await db.from("profiles").update(allowed).eq("id", submission.merchant_id);
        if (profileError) throw profileError;
      }
      const { error } = await db.from("merchant_profile_submissions").update({
        status: decision, review_note: note, reviewed_by: user.id, reviewed_at: new Date().toISOString(),
      }).eq("id", submission.id);
      if (error) throw error;
      return json({ success: true, status: decision });
    }
    return json({ error: "Tipo de revisión desconocido." }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo revisar la publicación." }, 500);
  }
});
