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
    const { payment_id, storage_path } = await req.json();
    if (!payment_id || !storage_path) return json({ error: "Falta el pago o la ruta del archivo." }, 400);
    if (!String(storage_path).startsWith(`${user.id}/${payment_id}/`)) {
      return json({ error: "La ruta del comprobante no corresponde al usuario y pago." }, 403);
    }
    const { data: payment } = await db.from("transfer_payments")
      .select("id,order_id,status").eq("id", payment_id).single();
    if (!payment || !["awaiting_transfer", "rejected"].includes(payment.status)) {
      return json({ error: "El pago no admite un nuevo comprobante." }, 409);
    }
    const { data: order } = await db.from("orders").select("customer_id").eq("id", payment.order_id).single();
    if (order?.customer_id !== user.id) return json({ error: "No podés adjuntar un comprobante a este pedido." }, 403);

    const { data: file } = await db.storage.from("payment-proofs").list(`${user.id}/${payment_id}`, { search: String(storage_path).split("/").pop() });
    if (!file?.length) return json({ error: "No se encontró el archivo subido al almacenamiento privado." }, 404);

    const { data: result, error: submitError } = await db.rpc("register_merlo_payment_proof", {
      p_payment_id: payment_id, p_storage_path: storage_path, p_actor_id: user.id,
    });
    if (submitError) {
      if (submitError.message?.includes("PAYMENT_NOT_ACCEPTING_PROOF")) {
        return json({ error: "El pago ya no admite comprobantes en su estado actual." }, 409);
      }
      if (submitError.message?.includes("PAYMENT_NOT_OWNED")) {
        return json({ error: "No podés adjuntar un comprobante a este pedido." }, 403);
      }
      throw submitError;
    }
    return json({ success: true, status: result?.status ?? "proof_submitted" });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo registrar el comprobante." }, 500);
  }
});
