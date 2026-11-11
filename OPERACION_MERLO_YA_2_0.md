# Merlo Ya 2.0 — Operación y puesta en marcha

## Estado actual

- Rama de trabajo: `merlo-ya-2.0-frontend-rebuild`.
- PR de integración: https://github.com/dbomballi-ctrl/merloya/pull/3 (draft; no fusionado).
- El proyecto Supabase conectado ya tiene las migraciones operativas y las Edge Functions desplegadas.
- El frontend se publica como Preview en Vercel. El plan Free alcanzó el límite de 100 despliegues diarios; el último Preview READY corresponde al commit `c1b77cd`, mientras que la rama tiene cambios posteriores aún no publicados.
- No se modificó `main` ni se hizo un despliegue de producción.

## Funcionalidad

### Cliente
- Catálogo público de comercios y productos aprobados.
- Registro, inicio de sesión, carrito e historial de pedidos.
- Checkout multicomercio.
- Modalidad `delivery`: dirección, zona y ubicación GPS; el backend calcula el recorrido y la tarifa.
- Modalidad `pickup`: retiro gratuito en cada comercio; no solicita dirección del cliente ni GPS y guarda la dirección de retiro de cada local.
- Transferencias bancarias manuales y carga privada de comprobantes.
- Seguimiento de entrega cuando el pedido es delivery.

### Comercio
- Solicitud de alta y edición de perfil con revisión de administración.
- La dirección del local es obligatoria para aprobar el perfil y habilitar retiro gratuito.
- Gestión de productos y moderación de publicaciones.
- Consulta de pedidos y revisión de comprobantes destinados al propio comercio.

### Administración
- Revisión de perfiles, comercios y productos.
- Configuración de cuenta de cobro de Merlo Ya y tarifas de delivery.
- Habilitación/deshabilitación de cuentas de repartidor.
- Asignación manual de pedidos delivery confirmados.
- Revisión de pagos de comercio y de delivery.

### Repartidor
- Consulta de entregas asignadas.
- Estados secuenciales: asignado → retirado del comercio → entregado.
- No hay seguimiento GPS en tiempo real.

## Flujo de checkout

1. El navegador envía IDs de producto, cantidades, modalidad y datos de entrega cuando corresponde.
2. `create-transfer-order` valida sesión, rol, publicación, precio y comercio desde Supabase. No confía en precios ni totales del navegador.
3. En delivery, valida ubicación del comercio y cliente, calcula la ruta y selecciona una tarifa activa.
4. En pickup, exige dirección del comercio, fija envío en ARS 0 y no crea una obligación de pago a Merlo Ya por delivery.
5. Una RPC crea pedido, subpedidos, ítems y transferencias en una transacción.
6. La clave de idempotencia evita duplicados ante reintentos.
7. El cliente transfiere manualmente y adjunta comprobantes privados.
8. Comercio y administración revisan los pagos según el destinatario.
9. El pedido queda confirmado cuando todos los pagos requeridos están verificados.
10. Para ambos modos se genera un enlace `wa.me` dirigido exclusivamente a Merlo Ya (`5491126306785`). WhatsApp abre con el texto preparado; el cliente debe tocar Enviar. No hay envío automático.

## Edge Functions desplegadas

- `create-transfer-order`
- `submit-transfer-proof`
- `review-transfer-payment`
- `review-merchant-catalog`
- `manage-platform-settings`
- `manage-delivery-assignment`
- `manage-courier-profiles`
- `super-service`

Las funciones operativas requieren JWT y validan el rol en servidor. La clave `SUPABASE_SERVICE_ROLE_KEY` solo existe en el runtime de Edge Functions y nunca debe incluirse en el frontend.

## Migraciones

El proyecto conectado registra las siguientes migraciones operativas:
- `20261110132000_atomic_transfer_order_creation`
- `20261110140000_checkout_idempotency`
- `20261110150000_atomic_payment_proof_submission`
- `20261110160000_atomic_payment_review`
- `20261110170000_profile_signup_trigger`
- `20261110180000_delivery_assignments`
- `20261110190000_security_hardening`
- `20261110200000_demo_catalog_media_and_moderation`
- `20261110210000_demo_checkout_without_real_transfers`
- `20261110220000_merchant_onboarding_requests`
- `restrict_public_merchant_view_access`
- `grant_authenticated_public_merchant_fields`
- `revoke_anon_private_table_access`
- `add_free_pickup_fulfillment`

El repositorio conserva además `202611080002_transferencias_multiproveedor.sql` como base histórica para reproducir el esquema desde el fixture local. No se debe volver a aplicar manualmente en el proyecto conectado sin verificar primero el historial de migraciones.

## Seguridad y CI

- RLS está habilitado en las tablas operativas.
- El rol `anon` conserva lectura solo del catálogo público; se revocó su acceso a tablas privadas de pedidos, pagos, cuentas y perfiles.
- `public_merchants` usa `security_invoker` y solo expone comercios aprobados, incluida su dirección comercial de retiro.
- La RPC privilegiada de checkout solo puede ejecutarse con `service_role`.
- El chequeo de Deno y la validación de sintaxis JavaScript/IDs HTML pasaron en GitHub Actions.
- La prueba local de migraciones detectó inicialmente que Supabase CLI aplicaba migraciones antes del fixture; se corrigió el workflow para iniciar el stack vacío, cargar el fixture y luego aplicar las migraciones. La nueva ejecución está pendiente de resultado.

## Configuración necesaria antes de abrir al público

1. Reemplazar datos demostrativos por comercios reales aprobados.
2. Cada comercio debe cargar dirección de retiro, coordenadas y cuenta bancaria.
3. Administración debe verificar el CBU/alias de Merlo Ya y establecer tarifas comerciales reales.
4. Crear una cuenta de usuario para cada repartidor y habilitarla desde el panel de administración.
5. Configurar `APP_ORIGIN` con el dominio web final y `ROUTING_BASE_URL` con un servicio de rutas con disponibilidad adecuada. El fallback público de OSRM es solo para pruebas.
6. Revisar confirmación de email, URL de redirección y políticas de Auth.
7. Activar Leaked Password Protection en Supabase Auth; el asesor de seguridad informa que actualmente está desactivado.
8. Completar una prueba end-to-end autenticada para delivery y pickup, incluyendo carga y revisión de comprobantes.
9. No fusionar el PR ni promover a producción hasta completar lo anterior.

## Datos de demostración y límites

- El catálogo conectado contiene un comercio demo y seis productos demo.
- Los pedidos demo no generan transferencias reales; no deben utilizarse como prueba de cobro.
- Los pagos reales son transferencias bancarias manuales, con verificación humana.
- La asignación de repartidores es manual; no hay tracking GPS en vivo.
- La notificación WhatsApp no se envía automáticamente: se abre el chat de Merlo Ya y el usuario confirma el envío.
