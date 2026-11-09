# Merlo Ya — integración inicial por transferencias

Esta carpeta une el diseño original con una primera interfaz de checkout por transferencia conectada a las tres Edge Functions del paquete. Conserva los datos de Supabase URL y publishable key que ya estaban en el HTML original.

## Estado

- Carrito frontend agrupado por comercio y persistente durante la navegación de la página.
- Checkout cliente invoca `create-transfer-order`.
- Solicita ubicación del cliente solo con consentimiento del navegador para calcular distancia vial.
- Muestra una obligación de transferencia por comercio y otra por envío a Merlo Ya.
- Permite subir comprobantes privados y llama a `submit-transfer-proof`.
- Incluye campos en el panel del comercio para guardar titular, alias/CBU y ubicación del comercio. No incluye todavía una interfaz completa de administración de tarifas/cuenta de Merlo Ya ni un panel operativo de revisión de transferencias.
- No fue posible probar contra el proyecto Supabase real; hay que validar con cuentas y productos reales antes de producción.

## Requisitos ya realizados por el usuario

La migración `202611080002_transferencias_multiproveedor.sql` fue ejecutada y las funciones `create-transfer-order`, `review-transfer-payment`, `submit-transfer-proof` fueron desplegadas. No vuelvas a ejecutar la migración sin revisar el estado.

## Antes de una compra de prueba

1. En `profiles`, cada comercio debe tener `latitude` y `longitude` correctos.
2. En `merchant_payment_accounts`, cada comercio debe tener `account_holder` y su alias/CBU.
3. En `platform_settings`, configurar la cuenta de Merlo Ya con `account_holder` válido, el alias `pochipochi82` y `id=true`.
4. Verificar que `delivery_rate_tiers` tenga rangos no superpuestos y tarifas de prueba.
5. Confirmar que existe el bucket privado `payment-proofs`.
6. En Supabase Edge Functions secrets, configurar `APP_ORIGIN` con el dominio exacto de Vercel. `ROUTING_BASE_URL` es opcional. No colocar `SUPABASE_SERVICE_ROLE_KEY` en el HTML ni en Vercel como variable pública.
7. El cliente debe tener perfil con `role='usuario'`; los comercios, `role='comercio'`.
8. Solo un administrador de confianza debe tener `profiles.role='admin'`.

## Importante sobre la ubicación

El botón de ubicación usa `navigator.geolocation`; el cliente debe aceptar explícitamente el permiso. La ubicación no se solicita al abrir la página, solo al tocar el botón.

## Despliegue Vercel

Subí el contenido de esta carpeta a la raíz de un repositorio GitHub. En Vercel importá ese repositorio como proyecto estático. No necesita build command; el directorio de salida es `.`. Configurá el dominio en `APP_ORIGIN` en Supabase.

## Limitaciones y seguridad

- La interfaz estática conserva pantallas antiguas de paneles; las operaciones de revisión de pagos deben hacerse por ahora con llamadas autorizadas o una siguiente interfaz de administración.
- OSRM público es un servicio de demostración sin SLA; no usarlo para operación comercial sostenida sin proveedor de rutas adecuado.
- El backend actual no hace toda la creación del pedido en una transacción SQL: si una inserción secundaria falla, revisar y limpiar el pedido parcial antes de reintentar.
- La aplicación no debe aceptar productos DEMO para pedidos reales.
- Probar primero con importes mínimos y cuentas propias; el sistema crea obligaciones de pago, no mueve dinero automáticamente.
