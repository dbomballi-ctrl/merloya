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
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Sesión inválida." }, 401);
  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: actor } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (actor?.role !== "admin") return json({ error: "Solo administración puede gestionar el catálogo." }, 403);

  try {
    const body = await req.json();
    const action = String(body.action ?? "");
    if (action === "list") {
      const [{ data: merchants, error: merchantError }, { data: products, error: productError }, { data: users, error: userError }] = await Promise.all([
        db.from("profiles").select("id,nombre,rubro,zona,domicilio,whatsapp,store_image_url,publication_status,role,is_demo").in("role", ["comercio", "usuario"]).order("nombre").limit(250),
        db.from("products").select("id,comercio_id,nombre,precio,image_url,description,publication_status,is_demo").order("created_at", { ascending: false }).limit(500),
        db.from("profiles").select("id,nombre,role").eq("role", "usuario").order("nombre").limit(250),
      ]);
      if (merchantError || productError || userError) throw merchantError ?? productError ?? userError;
      return json({ success: true, merchants: merchants ?? [], products: products ?? [], candidate_users: users ?? [] });
    }

    if (action === "save_merchant") {
      const id = String(body.id ?? "");
      const nombre = String(body.nombre ?? "").trim().slice(0, 120);
      const rubro = String(body.rubro ?? "").trim().slice(0, 80);
      const zona = String(body.zona ?? "").trim().slice(0, 120);
      const domicilio = String(body.domicilio ?? "").trim().slice(0, 250);
      const whatsapp = String(body.whatsapp ?? "").trim().slice(0, 40);
      const store_image_url = String(body.store_image_url ?? "").trim().slice(0, 1000);
      if (!id || !nombre || !rubro || !domicilio) return json({ error: "Nombre, rubro, dirección e identificador de cuenta son obligatorios." }, 400);
      if (store_image_url && !/^https:\/\//i.test(store_image_url)) return json({ error: "La foto debe usar HTTPS." }, 400);
      const { data: target } = await db.from("profiles").select("id,role,publication_status").eq("id", id).maybeSingle();
      if (!target || !["usuario", "comercio"].includes(target.role)) return json({ error: "La cuenta seleccionada no puede convertirse en comercio." }, 404);
      const { data, error } = await db.from("profiles").update({
        nombre, rubro, zona: zona || null, domicilio, whatsapp: whatsapp || null,
        store_image_url: store_image_url || null, role: "comercio",
        publication_status: target.role === "comercio" ? target.publication_status : "approved",
      }).eq("id", id).select("id,nombre,role,publication_status").single();
      if (error) throw error;
      return json({ success: true, merchant: data });
    }

    if (action === "set_merchant_status") {
      const id = String(body.id ?? "");
      const status = body.status === "approved" ? "approved" : body.status === "rejected" ? "rejected" : null;
      if (!id || !status) return json({ error: "Estado o comercio inválido." }, 400);
      const { data, error } = await db.from("profiles").update({ publication_status: status })
        .eq("id", id).eq("role", "comercio").select("id,publication_status").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "No se encontró el comercio." }, 404);
      return json({ success: true, merchant: data });
    }

    if (action === "save_product") {
      const id = String(body.id ?? "");
      const comercio_id = String(body.comercio_id ?? "");
      const nombre = String(body.nombre ?? "").trim().slice(0, 160);
      const precio = Number(body.precio);
      const image_url = String(body.image_url ?? "").trim().slice(0, 1000);
      const description = String(body.description ?? "").trim().slice(0, 500);
      const status = ["approved", "pending", "rejected"].includes(body.publication_status) ? body.publication_status : "approved";
      if (!comercio_id || !nombre || !Number.isFinite(precio) || precio <= 0) return json({ error: "Comercio, nombre y precio válido son obligatorios." }, 400);
      if (image_url && !/^https:\/\//i.test(image_url)) return json({ error: "La foto debe usar HTTPS." }, 400);
      const { data: merchant } = await db.from("profiles").select("id,role,publication_status").eq("id", comercio_id).maybeSingle();
      if (!merchant || merchant.role !== "comercio") return json({ error: "El comercio seleccionado no existe." }, 404);
      const payload = { comercio_id, nombre, precio, image_url: image_url || null, description: description || null, publication_status: status };
      const result = id
        ? await db.from("products").update(payload).eq("id", id).select("id,nombre,publication_status").maybeSingle()
        : await db.from("products").insert(payload).select("id,nombre,publication_status").single();
      if (result.error) throw result.error;
      if (!result.data) return json({ error: "No se encontró el producto para modificar." }, 404);
      return json({ success: true, product: result.data });
    }

    if (action === "delete_product") {
      const id = String(body.id ?? "");
      if (!id) return json({ error: "Falta el producto." }, 400);
      const { data, error } = await db.from("products").delete().eq("id", id).select("id").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "El producto no existe o ya fue eliminado." }, 404);
      return json({ success: true, deleted_id: data.id });
    }
    return json({ error: "Acción desconocida." }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "No se pudo gestionar el catálogo." }, 500);
  }
});
