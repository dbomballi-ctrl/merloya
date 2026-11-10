# Merlo Ya 2.0 — Operación y puesta en marcha

Este documento describe el circuito implementado en `merlo-ya-2.0-dev` y lo que falta para habilitarlo. **Los cambios de código no implican que Supabase o Vercel ya estén desplegados.**

## Flujo de pedidos

1. El cliente inicia sesión y envía carrito, dirección y coordenadas.
2. `create-transfer-order` valida la sesión, el perfil, los productos, los comercios, las cuentas de destino y la tarifa de delivery.
3. La Edge Function calcula los importes desde los datos de Supabase; no confía en precios ni totales enviados por el navegador.
4. Una RPC crea el pedido, subpedidos, ítems y obligaciones de transferencia dentro de una sola transacción.
5. La clave `Idempotency-Key` identifica el intento. Un reintento con la misma clave y los mismos datos recupera el pedido; la misma clave con datos distintos se rechaza.
6. El cliente transfiere por separado a cada destino y adjunta el comprobante privado.
7. El comercio revisa únicamente la transferencia destinada a ese comercio. Administración puede revisar también la transferencia de delivery.
8. La revisión actualiza el pago y los estados derivados del pedido mediante el trigger de base de datos.

## Migraciones SQL

Aplicar en orden, primero en un proyecto Supabase de staging:

1. `202611080002_transferencias_multiproveedor.sql`
2. `20261110132000_atomic_transfer_order_creation.sql`
3. `20261110140000_checkout_idempotency.sql`
4. `20261110150000_atomic_payment_proof_submission.sql`
5. `20261110160000_atomic_payment_review.sql`
6. `20261110170000_profile_signup_trigger.sql`
7. `20261110180000_delivery_assignments.sql`
8. `20261110190000_security_hardening.sql`

Las migraciones deben ejecutarse una sola vez por entorno y verificarse contra el esquema real antes de producción. No ejecutar manualmente solo una migración posterior: las RPC dependen de las tablas creadas por la primera.

## Edge Functions

Desplegar estas funciones desde el proyecto Supabase correcto:

- `create-transfer-order`
- `submit-transfer-proof`
- `review-transfer-payment`
- `manage-platform-settings` (solo administración)
- `manage-delivery-assignment` (administración y repartidores autenticados)

Variables requeridas en el entorno de Edge Functions:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (solo como secret del runtime; nunca en el frontend)

Variables opcionales:

- `APP_ORIGIN`: origen web permitido para CORS.
- `ROUTING_BASE_URL`: endpoint compatible con OSRM. Si se omite, se usa el servicio público de demostración; no ofrece SLA para producción.

## Configuración operativa necesaria

Antes de una prueba end-to-end deben configurarse en staging:

- Cuenta bancaria/CBU/alias de Merlo Ya en `platform_settings` (desde el panel de administración).
- Cuenta de transferencia y coordenadas de cada comercio en `merchant_payment_accounts` y `profiles`.
- Tarifas reales de delivery en `delivery_rate_tiers`. Los valores iniciales de la migración son demostrativos y no deben usarse como tarifas comerciales sin aprobación. Los tramos usan límites `[min_km, max_km)`, deben ser contiguos, empezar en 0 km y el último debe tener límite superior abierto.
- Dominio de Vercel como `APP_ORIGIN`.
- Políticas de autenticación, confirmación de email y URL de redirección de Supabase.
- Un cliente, un comercio y un usuario administrador de prueba.

## Pruebas de aceptación en staging

- Cliente no autenticado: checkout devuelve 401.
- Cuenta sin rol cliente: checkout devuelve 403.
- Producto inexistente o cantidad inválida: checkout se rechaza.
- Carrito con dos comercios: crea un pedido, dos subpedidos y sus transferencias correspondientes.
- Dos llamadas simultáneas con la misma clave y payload: existe un único pedido.
- Misma clave con payload diferente: devuelve conflicto y no crea otro pedido.
- Error durante la inserción de ítems o pagos: la transacción completa hace rollback.
- Cliente carga JPG, PNG y PDF de hasta 5 MB; un archivo mayor o MIME no permitido se rechaza.
- Cliente no puede cargar comprobantes en pedidos ajenos.
- Comercio solo puede verificar/rechazar su propia transferencia.
- Comercio no puede revisar la transferencia de delivery ni la de otro comercio.
- Administración puede revisar ambas clases de transferencia.
- Pedido queda confirmado únicamente cuando todas las transferencias están verificadas.
- Administración puede asignar un pedido confirmado a un perfil repartidor.
- El repartidor solo ve sus entregas y puede pasar de asignado a retirado y de retirado a entregado.
- El cliente puede consultar el estado de entrega desde el historial de pedidos.
- Archivos de comprobantes no son accesibles sin autorización; los enlaces firmados expiran.

## Límites actuales

- No se procesa dinero automáticamente: el pago es por transferencia y revisión humana.
- La asignación manual de repartidores y los estados asignado/retirado/entregado están implementados con actualización transaccional; no hay tracking GPS en tiempo real.
- El retiro por parte del cliente en el comercio todavía no está implementado en el checkout.
- Los perfiles con rol `repartidor` deben ser habilitados por administración; no existe alta pública de repartidores.
- El rol `repartidor` está permitido por la restricción de perfiles, pero no puede ser elegido desde el registro público.
- La migración de hardening elimina la lectura/inserción pública de perfiles, restringe las columnas expuestas, limita ventas heredadas y exige rol comercio para modificar productos.
- No se ha ejecutado una prueba real contra staging, porque el repositorio no proporciona acceso administrativo ni secretos de Supabase/Vercel.
- No se debe fusionar a `main` ni desplegar a producción hasta completar las pruebas anteriores y revisar las tarifas/destinos bancarios reales.
