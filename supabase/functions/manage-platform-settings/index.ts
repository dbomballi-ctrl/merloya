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
    if (profileError || profile?.role !== "admin") return json({ error: "Solo administración puede modificar la configuración." }, 403);

    const body = await req.json();
    if (body.action === "save_account") {
      const holder = String(body.account_holder ?? "").trim();
      const bank = String(body.bank_name ?? "").trim();
      const alias = String(body.alias ?? "").trim();
      const cbu = String(body.cbu ?? "").trim();
      if (!holder || (!alias && !cbu) || holder.length > 120 || bank.length > 120 || alias.length > 80 || cbu.length > 30) {
        return json({ error: "Titular, alias o CBU son obligatorios; verificá los límites de longitud." }, 400);
      }
      const { error } = await db.from("platform_settings").upsert({
        id: true, account_holder: holder, bank_name: bank || null, alias: alias || null, cbu: cbu || null, currency: "ARS",
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
      if (error) throw error;
      return json({ success: true });
    }

    if (body.action === "save_rates") {
      const rates = body.rates;
      if (!Array.isArray(rates) || rates.length < 1 || rates.length > 20) {
        return json({ error: "Configurá entre 1 y 20 tramos de tarifa." }, 400);
      }
      const normalized = rates.map((rate: any, index: number) => ({
        ...(rate.id ? { id: rate.id } : {}),
        label: String(rate.label ?? "").trim(),
        min_km: Number(rate.min_km),
        max_km: rate.max_km === null || rate.max_km === "" ? null : Number(rate.max_km),
        fee: Number(rate.fee),
        active: true,
        sort_order: index + 1,
      }));
      if (normalized.some((r: any) => !r.label || r.label.length > 80 ||
          !Number.isFinite(r.min_km) || r.min_km < 0 ||
          (r.max_km !== null && (!Number.isFinite(r.max_km) || r.max_km <= r.min_km)) ||
          !Number.isFinite(r.fee) || r.fee < 0)) {
        return json({ error: "Hay tramos con etiqueta, distancia o importe inválido." }, 400);
      }
      normalized.sort((a: any, b: any) => a.min_km - b.min_km);
      for (let i = 1; i < normalized.length; i++) {
        const previous = normalized[i - 1];
        if (previous.max_km === null || normalized[i].min_km <= previous.max_km) {
          return json({ error: "Los tramos de distancia no pueden superponerse." }, 400);
        }
      }
      const { data: existing, error: existingError } = await db.from("delivery_rate_tiers").select("id");
      if (existingError) throw existingError;
      const { error: upsertError } = await db.from("delivery_rate_tiers").upsert(normalized);
      if (upsertError) throw upsertError;
      const keep = normalized.map((r: any) => r.id).filter(Boolean);
      const obsolete = (existing ?? []).map((r: any) => r.id).filter((id: string) => !keep.includes(id));
      if (obsolete.length) {
        const { error: deactivateError } = await db.from("delivery_rate_tiers").update({ active: false }).in("id", obsolete);
        if (deactivateError) throw deactivateError;
      }
      return json({ success: true, saved: normalized.length });
    }

    return json({ error: "Acción de configuración desconocida." }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo guardar la configuración." }, 500);
  }
});
