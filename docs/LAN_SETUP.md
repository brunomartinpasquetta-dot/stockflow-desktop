# Modo multi-caja LAN

StockFlow soporta operar con varias cajas en una misma red local (LAN),
todas trabajando contra la misma base de datos.

## Arquitectura

```
        ┌───────────────────────┐
        │   PC SERVIDOR         │
        │   (BD SQLite + web)   │
        │   :7777 (Fastify-lite)│
        └─────────▲─────────────┘
                  │ HTTP /lan/rpc
       ┌──────────┼──────────┐
       │          │          │
   ┌───┴───┐  ┌───┴───┐  ┌───┴───┐
   │CLIENTE│  │CLIENTE│  │CLIENTE│
   │(hard- │  │(hard- │  │(hard- │
   │ ware  │  │ ware  │  │ ware  │
   │ local)│  │ local)│  │ local)│
   └───────┘  └───────┘  └───────┘
```

- **Servidor**: tiene la base de datos. Ejecuta el `LanServer` en el puerto
  7777. Su impresora/balanza siguen siendo locales.
- **Clientes**: no tienen base de datos propia. El renderer rutea todas las
  llamadas IPC de datos (artículos, ventas, clientes, etc.) al servidor por
  HTTP. La impresora/balanza son las de la PC cliente.

## Requisitos de red

- Todas las PCs en la **misma subnet** (ej. `192.168.1.x`).
- La PC servidor con **IP fija** o reservada en el router DHCP.
- Firewall del SO autoriza el **puerto 7777** entrante en la PC servidor.

### Windows

```powershell
# Como administrador
New-NetFirewallRule -DisplayName "StockFlow LAN" -Direction Inbound `
  -Protocol TCP -LocalPort 7777 -Action Allow
```

### macOS

Preferencias del Sistema → Seguridad y Privacidad → Firewall → Opciones →
agregar StockFlow → "Permitir conexiones entrantes".

### Linux (ufw)

```bash
sudo ufw allow 7777/tcp
```

## Wizard de bienvenida (primera ejecución)

La primera vez que se abre StockFlow en una PC, aparece la pantalla
**Bienvenida** con tres opciones (PC única / Servidor / Cliente). Elegila y
seguí los pasos: la app reinicia y queda en el modo elegido.

Si necesitás cambiar el modo más adelante: **Configuración → LAN**.

## Activar modo servidor

1. Abrir StockFlow en la PC que actuará de servidor.
2. Iniciar sesión como **admin**.
3. Configuración → LAN → **Servidor** → Guardar.
4. Anotar el **PIN de 6 dígitos** que aparece en pantalla.
5. **Reiniciar StockFlow**.

Al volver a abrir, los logs del proceso main muestran:

```
[LAN] modo=server puerto=7777 IP=192.168.1.10 PIN=123456
```

Esa IP + PIN se entregan a cada caja cliente.

## Activar modo cliente

1. Abrir StockFlow en la PC cliente.
2. Iniciar sesión como **admin** (sólo la primera vez, para configurar).
3. Configuración → LAN → **Cliente**.
4. Ingresar IP del servidor (ej. `192.168.1.10`), puerto (default `7777`)
   y el PIN.
5. **Reiniciar StockFlow**.

A partir de ahí, el cliente no usa su base de datos local: todas las
operaciones viajan por HTTP al servidor.

## Autenticación entre cajas

Cada cliente LAN tiene su propio login local. Al hacer login, el server LAN
firma un **JWT (HS256)** corto (12 h) que el cliente envía en
`Authorization: Bearer <jwt>` para los siguientes RPCs. El secret del JWT
deriva del PIN compartido; cuando el PIN se regenera, las sesiones existentes
quedan invalidadas y los clientes deben volver a loguearse.

En el header del cliente aparece un indicador **LAN** verde (conectado) o rojo
(reintentando…). Mientras el indicador esté rojo, la app bloquea operaciones
de escritura (igual que en el caso `readOnly` de la licencia).

## Quota de licencias

Cada PC (servidor o cliente) consume 1 licencia del tenant en la nube.
Si el tenant tiene `licensesQuota = 1` (default), sólo una PC puede activar
licencia. Para multi-caja contactá al soporte para ampliar la quota o
gestionalo desde el panel admin (`PATCH /api/admin/tenants/:id/quota`).

## Troubleshooting

### "Connection refused" desde el cliente

- Verificá que la PC servidor esté corriendo StockFlow.
- Confirmá la IP del servidor con `ipconfig` (Windows) o `ifconfig` (macOS/Linux).
- Probá `curl -X POST http://IP:7777/lan/rpc -d '{}'` desde el cliente.
- Revisá el firewall del SO en el servidor.

### "Token inválido"

El PIN guardado en el cliente no coincide con el del servidor. Volvé a
Configuración → LAN en el servidor y verificá el PIN; reingresalo en cada
cliente.

### El servidor cambió de IP

Si la PC servidor recibe IP por DHCP y cambió, reservala fija en el router
o reconfigurá cada cliente con la nueva IP.

### Hardware de la caja cliente

La impresora térmica, balanza y cajón monedero son **siempre locales** a la
PC cliente. Configurá cada uno desde Configuración → Hardware en esa PC.
