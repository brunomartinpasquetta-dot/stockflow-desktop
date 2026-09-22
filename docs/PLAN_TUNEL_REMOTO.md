# Acceso remoto por túnel — plan de trabajo

Fecha: 22-sep-2026. Estado: **plan, nada implementado**. Base leída: `apps/desktop/electron/lan/*`, `apps/desktop/electron/preload-bridge.ts`, `apps/desktop/src/web/webBridge.ts`, `apps/desktop/electron/main.ts`, el túnel de Alpha (`~/ALPHAGESTION/alfajores-erp/src/server/tunel.ts`, `src/server/plugins/guardia-pin.ts`) y la memoria del proyecto (`cloud-vps-deploy.md`, `release-pipeline-desktop.md`, `terminal-web-modo-navegador.md`).

## 1. Qué se va a construir

El comerciante prende un interruptor en Configuración → LAN, sentado en la PC del local, y le queda una dirección fija del estilo `https://<cliente>.remoto.<dominio>`. Desde su casa abre esa dirección en la tablet, pasa un segundo factor, entra con su usuario y contraseña de siempre y trabaja con la misma interfaz. Detrás: la aplicación abre sola una conexión **saliente** desde la PC del local hacia el borde (nada de abrir puertos en el router del comercio), y ese borde pone el HTTPS y la autenticación. Del lado de la aplicación, lo que entra por el túnel se trata como una **red distinta de la LAN**: menos canales habilitados, credencial propia y rastro propio. Si la PC del local está apagada, la dirección muestra "sistema apagado" en vez de un error del navegador.

## 2. Decisión de arquitectura

**Recomendación: Cloudflare Tunnel (`cloudflared`) como transporte, con el módulo de túnel escrito detrás de una interfaz `iniciar()/detener()/estado()`** para que el SSH inverso contra VPS propio quede como implementación alternativa, ya diseñada, sin reescribir la aplicación.

Los cuatro argumentos, en orden de peso:

1. **El alta y la baja son una llamada a API.** Sin puerto asignado, sin vhost, sin `certbot`, sin registro de puertos. Eso es exactamente lo que en Alpha no se resolvió: el puerto 8110 está fijo en `tunel.ts` y por eso no pueden convivir la fábrica y la Mac de Bruno.
2. **La credencial es por instalación y se revoca desde el panel.** Es la herida más cara de Alpha: clave compartida adentro del `.exe`, en un repo de releases público (el de StockFlow también lo es — `release-pipeline-desktop.md`), y la rotación exige visitar cada PC. Acá una baja no requiere viajar.
3. **Saca del camino al VPS.** `187.127.20.131` es compartido con sitios de otros clientes, ya tuvo un accidente que borró datos de un tenant, corre el cloud de licencias y **banea ~1 h a las IP que abren ráfagas de conexiones SSH** (`cloud-vps-deploy.md`) — justo lo que hace un comercio con internet inestable reconectando con backoff.
4. **Cloudflare Access pone la autenticación en el borde** (código por correo) antes de que la aplicación sirva una sola línea de HTML. Ese es el requisito de seguridad nº 2 y, por el camino propio, hay que construirlo a mano.

Lo que se paga, dicho de frente: el tráfico del comercio (ventas, clientes con CUIT y domicilio, fiscal) pasa por infraestructura de Cloudflare y eso hay que declararlo al cliente; hay que delegar la zona DNS del dominio que se use (ya hay experiencia con `leodiana.com.ar`); y suma `cloudflared` (~50 MB) al instalador o una descarga en el alta.

- **Se descarta SSH propio al VPS como primera opción** (no como diseño: el del relevamiento 3 está completo — rango 8150–8199, usuario sin shell, `permitlisten` y **no** `permitopen`, que es un error a corregir también en Alpha). Motivo: cada alta toca DNS + `authorized_keys` + nginx + certbot en una máquina de producción compartida, para siempre, y una persona sola no sostiene eso además de desarrollar.
- **Se descarta VPN (Tailscale/WireGuard) como función del producto**: no hay URL pública ni certificado, cada persona debe instalar la aplicación y entrar a la tailnet, y el plan de negocio se cobra por usuario. Sirve como paliativo (sección 8) y como camino de emergencia si el borde se cae.
- **Se descarta FRP**: resuelve los puertos, pero suma un binario propio para empaquetar y firmar en Windows y deja el TLS igual de a cargo de Bruno.

**Contradicción entre relevamientos, resuelta:** el relevamiento de Alpha dice "copiar Alpha" y el de infraestructura dice "Cloudflare". Se copia de Alpha **todo el lado de la aplicación** —que es el 80% del trabajo y donde están los errores ya pagados— y no se copia el transporte ni la administración manual, que es justamente lo que en Alpha quedó sin resolver.

## 3. Etapas

### Etapa 0 — Preparación (sin código de túnel)

- **Entrega:** decisiones de la sección 5 cerradas, dominio delegado, borde de prueba armado y **gracia de licencia ampliada**.
- **Toca:** `apps/desktop/electron/license/LicenseManager.ts` (hoy el JWT de licencia vale ~7 días — líneas 11 y 485) y el cloud. Motivo: con el cloud caído más de una semana el comercio **deja de facturar**; el túnel no lo empeora, pero lo vuelve mucho más visible. Conviene antes que el túnel.
- **Prueba:** un subdominio de laboratorio publicando un `http` cualquiera de la Mac.
- **Liberable:** no.

### Etapa 1 — Un cliente, superficie chica (el mínimo que ya sirve para Paranacito)

- **Entrega:** acceso remoto para **una** instalación, con TLS y segundo factor en el borde, PIN fuera de la URL y una lista blanca remota bastante más chica que la de LAN.
- **Toca:**
  - Nuevo `apps/desktop/electron/lan/TunelManager.ts`: `iniciar/detener/estado`, reintento exponencial con tope, credencial en `userData` con permisos cerrados, arranque con la sesión de Windows. Se arranca desde `apps/desktop/electron/main.ts:392`.
  - `main.ts:392`: desacoplar "acceso remoto" de `mode === 'server'` (hoy sin modo servidor no existe `LanServer`), sin mDNS (`main.ts:404`) y sin abrir el 7777 a la LAN.
  - `apps/desktop/electron/lan/LanServer.ts:292-308`: segundo listener atado **sólo a `127.0.0.1`**, con marca `esTunel` en la conexión. "Vino por el túnel" tiene que ser propiedad del socket, no de un header.
  - `LanServer.ts:509`, `:528`, `:565` y `:354`: un `ipCliente(req)` que lee `X-Forwarded-For` **sólo** si la conexión es la del listener del túnel, toma el último salto y agrupa por /24 y /64 para el contador. Hoy el bloqueo por 5 PIN fallidos (`MAX_FALLOS_PIN`, `LanServer.ts:123`) se indexa por `req.socket.remoteAddress`: detrás del túnel todos son `127.0.0.1` y **un tercero deja afuera al dueño**.
  - `LanServer.ts:476-504`: mover el estático, `/lan/ping` y `/lan/changes` **detrás** del guardia de origen. Hoy se resuelven antes y sin credencial; el ping publica versión y estado de licencia a quien pregunte.
  - `LanServer.ts:231-233` y `:429`: CORS acotado al origen propio en lugar de `*`.
  - `apps/desktop/electron/preload-bridge.ts:124-141`: lista blanca **remota**, separada de la de LAN y junto a ella. Afuera como mínimo: emisión `fiscal:*`, `backup:*`, `import:*`, `priceUpdate:apply`, `company:upsert`, `sales:voidSalesInRange`, `catalogo:syncConfigurar` y `fiscal:openPdfFolder` (hace `shell.openPath` en la PC del mostrador).
  - `apps/desktop/src/web/webBridge.ts:65-78`: el PIN deja de viajar en la URL; hay pantalla de emparejamiento usando `faltaPin`/`guardarPin` (`webBridge.ts:81-87`), que ya existen y no las llama nadie.
  - `webBridge.ts:42` y `preload-bridge.ts:219`: arman `http://ip:7777` fijo. Servida por HTTPS, la interfaz queda con contenido mixto y el navegador la bloquea.
  - `main.ts:422` y `main.ts:242`: el PIN sale del log en disco y de la línea de comandos.
  - Interfaz: tarjeta "Acceso remoto" en `apps/desktop/src/pages/Configuracion.tsx:737`, con interruptor, `Estado: Conectado / Desconectado / Reconectando`, la dirección con botón de copiar y apagado inmediato **sin reiniciar la aplicación**. Sólo en la PC del local y sólo administradores (el grupo `lan` no viaja por red).
- **Prueba:** `pnpm --filter @stockflow/desktop test:seguridad-lan` con casos nuevos en `apps/desktop/electron/__tests__/seguridad-lan.smoke.ts`: seis PIN fallidos con seis `X-Forwarded-For` distintos siguen dando 429; XFF enviado fuera del túnel se ignora; dos IP reales distintas detrás del túnel no se bloquean entre sí; con sesión remota `fiscal:issueInvoice` da **403** y con sesión LAN da 200. Fuera del smoke: el instalador publicado descomprimido no contiene ninguna credencial de túnel, y la interfaz servida por `https://…` no tiene contenido mixto en la consola.
- **Liberable:** sí, a **un** cliente acompañado. La baja de acceso se hace desde el panel del borde.

### Etapa 2 — Identidad, revocación y rastro

- **Entrega:** dispositivos con nombre, corte individual y auditoría que dice de dónde entró cada uno.
- **Toca:** `LanServer.ts:334-365` (el `Map` se indexa por IP: con el túnel todos los remotos colapsan en una fila `127.0.0.1`), `LanServer.ts:639-652` y `verifyJwt` (`:181-205`) para sumar `jti`/dispositivo y lista de revocación — hoy el JWT dura 12 h fijas y la única palanca es rotar el secreto, que desloguea a todo el local; `packages/db/src/schema/local.ts:914-930` y `apps/desktop/electron/ipc/audit.ts:29-33` (hoy sólo escrituras exitosas, sin IP ni dispositivo, y el grupo `lan` excluido); lista de dispositivos en `Configuracion.tsx:935-973`. Más contraseña fuerte obligatoria antes de habilitar lo remoto: el seed crea `admin/admin` (`packages/db/src/seed.ts:82-85`) y el mínimo es de 4 caracteres (`packages/shared/src/schemas/user.schema.ts:29`).
- **Prueba:** token revocado → 401; "cerrar todas las sesiones" invalida lo anterior; un ingreso remoto deja fila en `audit_log` con IP real y origen `remoto`; el panel muestra la sesión remota como remota y no como `127.0.0.1`.
- **Liberable:** sí, a cualquier cliente que lo pida.

### Etapa 3 — Multi-cliente y operación

- **Entrega:** alta y baja en minutos, estado verificado de verdad y aviso cuando un túnel se cae.
- **Toca:** carpeta nueva `deploy/remoto/` en el repo (script de alta/baja y registro de instalaciones, para que la receta no viva en la cabeza de Bruno), verificación real del estado —no la heurística de 3 segundos de Alpha (`tunel.ts:223-230`)—, aviso al dueño y a Bruno, y la página de "sistema apagado".
- **Prueba:** dos instalaciones de laboratorio en simultáneo; forzar la misma identidad → la aplicación se niega a levantar el túnel y lo dice en pantalla, no en silencio.
- **Liberable:** sí, como función vendible del producto.

## 4. Seguridad innegociable, y en qué etapa entra

| Requisito | Etapa |
|---|---|
| TLS en el borde con HSTS; nada de puerto crudo publicado | 1 |
| Autenticación en el borde antes de servir HTML (Access), y estático + `/lan/ping` detrás del guardia | 1 |
| PIN fuera de la URL, fuera del log y fuera de la línea de comandos | 1 |
| `X-Forwarded-For` confiable sólo desde el listener del túnel, último salto | 1 |
| Credencial del túnel generada/guardada en `userData`, **nunca** en el instalador | 1 |
| Lista blanca remota separada: emisión fiscal, `backup`, `import`, `priceUpdate`, `company:upsert` afuera | 1 |
| CORS acotado, CSP y `frame-ancestors` | 1 |
| Una identidad por instalación (no compartida entre clientes) | 1 |
| Sesiones revocables una por una y "cerrar todas las sesiones" | 2 |
| Contraseña fuerte obligatoria para habilitar lo remoto (hoy `admin/admin` y mínimo 4) | 2 |
| Auditoría con IP real, dispositivo y origen, incluyendo intentos fallidos | 2 |
| Corte de un cliente desde el borde en menos de un minuto, con procedimiento escrito | 3 |
| Acuerdo escrito con el comercio (qué se expone, Ley 25.326, quién responde) | antes de cobrar por esto |

## 5. Lo que hay que decidir antes de empezar

1. **Dominio.** ¿`remoto.bpsgsistemas.com`? ¿Dónde vive hoy la zona de `bpsgsistemas.com` y se acepta delegarla (o subdelegar `remoto.`) a Cloudflare? Si la respuesta es no, se va al plan B (SSH propio) y la etapa 1 crece.
2. **Borde.** ¿Se abre cuenta Cloudflare Zero Trust a nombre de BPSG, con Access por correo? ¿Quién figura como titular de los túneles de los clientes?
3. **VPS.** Si se elige el plan B: ¿el túnel va al VPS compartido `187.127.20.131` o a uno chico dedicado (~USD 5/mes)? ¿Cuánto disco y RAM libres hay hoy? (no se pudo mirar: **a confirmar con Bruno**, requiere SSH).
4. **Alcance remoto.** ¿Qué módulos quedan afuera además de los de la sección 4? Propuesta: afuera toda emisión fiscal, caja y cuentas corrientes en la etapa 1, y habilitables a mano por el dueño recién en la etapa 3.
5. **Precio.** ¿El acceso remoto se cobra aparte, va incluido en la licencia, o es sólo para el plan más caro? Define si la etapa 3 se hace o se posterga.
6. **Paranacito.** ¿Cuántas PC tiene el local? Si es una sola, hoy no hay `LanServer` (`main.ts:392`) y la salida provisoria de la sección 8 exige pasarlo a modo servidor, que reinicia la aplicación y pide una regla de firewall (`apps/desktop/electron/ipc/handlers/lan.handlers.ts:190-211`).
7. **Alpha.** ¿Se rota de una vez la clave de `tunelalpha` y se revisa su `authorized_keys` (`permitlisten`, no `permitopen`)? Está pendiente desde septiembre y es la misma familia de riesgo.

## 6. Piedras ya pisadas en Alpha que no hay que repetir

1. **Credencial adentro del instalador.** En Alpha viajó en `extraResources` del 20-ago al 17-sep, en un repo público. Va en `userData`, con permisos cerrados, y el smoke de release lo verifica.
2. **Credencial en `resources/`.** El instalador borra y reemplaza esa carpeta en cada update: el túnel se cayó tras una actualización y no volvió solo. `userData` sobrevive (misma regla que los certificados ARCA).
3. **Decidir "remoto" por la IP.** Por el túnel todo llega de `127.0.0.1`; Alpha terminó decidiendo por el `Host`, que es una heurística. Acá se decide por **el listener**, que no se puede falsificar.
4. **Contador de intentos sobre una IP compartida.** Es el bug nº 1 de este plan: sin arreglarlo, cinco intentos de un desconocido dejan al dueño afuera diez minutos, renovables.
5. **Rutas nuevas que no se agregan a la lista blanca** y la tablet empieza a dar 403. Regla fija: toda ruta o canal nuevo del módulo remoto se agrega a la lista en el mismo commit.
6. **"Probado" contra loopback.** Probar siempre con el `X-Forwarded-For` puesto y con **control negativo obligatorio**: un canal prohibido tiene que dar 403.
7. **Puerto fijo por producto.** No escala: en Alpha no pueden convivir dos instalaciones. Una identidad por instalación desde el día uno.
8. **Timers de reintento apilados** (dos procesos peleando el mismo puerto y errores falsos) y **reconexión que falla en silencio** sin keepalives. Un solo timer, nunca con hijo vivo, y keepalives siempre.
9. **Persistir el resultado en vez de la intención.** Si el primer intento falla, el interruptor tiene que quedar prendido igual y reintentar.
10. **`/health` hablador.** El equivalente acá es `/lan/ping`, que hoy publica versión y estado de licencia sin credencial.

## 7. Esfuerzo estimado (días de trabajo efectivo, una persona)

| Etapa | Días | Nota |
|---|---|---|
| 0 — Preparación y gracia de licencia | 2–3 | La mitad es trámite (DNS, cuenta, certificados) |
| 1 — Un cliente, superficie chica | 12–16 | Incluye pruebas reales en la PC del cliente; en Alpha esto se estabilizó entre la 1.9.6 y la 1.9.14 |
| 2 — Identidad, revocación y rastro | 5–7 | Toca base de datos (migración de `audit_log`) e interfaz |
| 3 — Multi-cliente y operación | 4–6 | Se puede postergar hasta el segundo cliente remoto |

Total realista hasta poder venderlo: **23 a 32 días**, más el tiempo de espera de las decisiones de la sección 5. **Segunda vuelta** (no entra en este plan): TOTP dentro de la aplicación, aviso al dueño por WhatsApp de cada ingreso remoto nuevo, exportación de la auditoría, bloqueo por país, alta autoservicio de subdominios, y alta disponibilidad del borde.

## 8. Mientras tanto, con el cliente de Paranacito

Si quiere entrar desde su casa ya, la salida es **Tailscale**, sin escribir una línea: `isLanRemote` (`LanServer.ts:207-226`) ya acepta el rango `100.64/10`, que es el que reparte Tailscale, así que la tablet entra a `http://100.x.y.z:7777` y el guardia la trata como red local. El cifrado lo pone Tailscale, cada dispositivo conserva su IP propia (el contador de fallos sigue discriminando y el panel de terminales sigue mostrando una fila por máquina) y no queda nada publicado en internet.

Cuatro advertencias para no vender humo:

- Sólo entra quien tenga la aplicación de Tailscale instalada y esté en la tailnet: no sirve para pasarle un enlace al contador.
- Si el local tiene **una sola PC**, hoy no hay `LanServer` (`main.ts:392`): hay que pasarlo a modo servidor, lo que reinicia la aplicación y pide la regla de firewall.
- La tablet entra con un usuario del sistema y **arrastra sus permisos RBAC tal cual**. Conviene crearle un usuario propio con permisos recortados por área (Configuración → Roles), no darle el `admin`.
- El PIN sigue viajando en la URL la primera vez (`webBridge.ts:65-78`) y queda en el historial de la tablet. Dentro de la tailnet es tolerable; por internet no lo sería.

Orden sensato: primero se lo pone a trabajar con StockFlow en el mostrador, después Tailscale como acceso remoto provisorio, y el túnel propio llega con la etapa 1 sin que él tenga que cambiar nada de su operación.
