import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":Deno.env.get("APP_ORIGIN")??"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  const auth=req.headers.get("Authorization");if(!auth)return json({error:"No autenticado."},401);
  const url=Deno.env.get("SUPABASE_URL")!;
  const userClient=createClient(url,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:auth}}});
  const {data:{user}}=await userClient.auth.getUser();if(!user)return json({error:"Sesión inválida."},401);
  const db=createClient(url,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const {data:profile}=await db.from("profiles").select("role").eq("id",user.id).maybeSingle();
  if(!profile||!["comercio","admin"].includes(profile.role))return json({error:"No tenés permisos para gestionar pedidos."},403);
  try{
    const body=await req.json();
    if(body.action==="list"){
      let query=db.from("merchant_orders").select("id,order_id,merchant_id,status,subtotal,shipping_fee,delivery_address_snapshot,merchant_name_snapshot,created_at,orders!inner(id,status,fulfillment_type,delivery_address,delivery_zone,customer_phone,total_amount,created_at),order_items(id,product_name_snapshot,unit_price,quantity,line_total)").order("created_at",{ascending:false}).limit(100);
      if(profile.role==="comercio")query=query.eq("merchant_id",user.id);
      const {data,error}=await query;if(error)throw error;
      return json({success:true,orders:data??[]});
    }
    if(body.action==="update_status"){
      const id=String(body.merchant_order_id??"");
      const next=String(body.status??"");
      if(!id||!["preparing","dispatched","delivered","cancelled"].includes(next))return json({error:"Estado inválido."},400);
      const {data:row,error:fetchError}=await db.from("merchant_orders").select("id,merchant_id,status,order_id,orders!inner(status,fulfillment_type)").eq("id",id).maybeSingle();
      if(fetchError||!row)return json({error:"Pedido inexistente."},404);
      if(profile.role==="comercio"&&row.merchant_id!==user.id)return json({error:"No podés modificar pedidos de otro comercio."},403);
      const parent=(row as any).orders;
      if(parent.status!=="confirmed")return json({error:"El pedido debe tener todos los pagos confirmados antes de prepararlo."},409);
      const allowed:Record<string,string[]>={confirmed:["preparing","cancelled"],preparing:parent.fulfillment_type==="pickup"?["delivered","cancelled"]:["dispatched","cancelled"],dispatched:[]};
      if(!(allowed[row.status]??[]).includes(next))return json({error:"Ese cambio de estado no está permitido."},409);
      if(next==="delivered"&&parent.fulfillment_type!=="pickup")return json({error:"Las entregas a domicilio las finaliza el repartidor asignado."},409);
      const {data:updated,error}=await db.from("merchant_orders").update({status:next}).eq("id",id).eq("status",row.status).select("id,status").maybeSingle();
      if(error)throw error;if(!updated)return json({error:"El pedido cambió de estado. Actualizá la pantalla."},409);
      return json({success:true,merchant_order:updated});
    }
    return json({error:"Acción desconocida."},400);
  }catch(error){console.error(error);return json({error:error instanceof Error?error.message:"No se pudo actualizar el pedido."},500)}
});
