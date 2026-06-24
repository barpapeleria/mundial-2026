# Mundial 2026 · Bar Papelería

Aplicación web para seguir el **Mundial 2026** con resultados, grupos, goleadores y llaves, integrada de forma comercial y sutil con **Bar Papelería Personalizada**.

> La app no transmite partidos ni video en vivo. Está pensada para mostrar novedades, resultados, grupos, llaves y contenido relacionado al Mundial.

---

## Objetivo del proyecto

Este proyecto funciona como una app complementaria al catálogo principal de Bar Papelería.

La idea es usar el interés del Mundial como gancho para atraer visitas y, al mismo tiempo, promocionar productos personalizados como:

- Stickers de Argentina.
- Stickers temática fútbol, Mundial, Argentina, “el 10” y colores celeste/blanco.
- Toppers mundialistas.
- Deco para cumpleaños.
- Papelería personalizada para eventos y emprendimientos.

---

## Características principales

- Resultados y partidos en vivo mediante **Server-Sent Events (SSE)**.
- Fallback automático a modo demo/simulación si no hay token o si la API falla.
- Visualización de grupos.
- Tabla de goleadores.
- Llaves / cruces del torneo.
- Banner comercial de Bar Papelería.
- CTA flotante para pedidos por WhatsApp.
- Botón para volver arriba al hacer scroll.
- Tracking seguro con `gtag` si Google Analytics está disponible.
- Diseño responsive, mobile-first y estilo glassmorphism.
- Endpoint administrativo protegido para ajustar reloj y marcador cuando el proveedor externo viene desfasado.

---

## Tecnologías utilizadas

- Node.js
- Express
- Server-Sent Events (SSE)
- HTML, CSS y JavaScript vanilla
- API de football-data.org
- dotenv para variables de entorno locales

---

## Estructura del proyecto

```txt
mundial-2026/
├── public/
│   ├── img/
│   │   └── logo-bar.png
│   └── index.html
├── server.js
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
└── README.md
```

---

## Requisitos

- Node.js 18 o superior.
- npm.
- Token de football-data.org para usar datos reales.

La app también puede funcionar sin token usando el modo demo/simulación.

---

## Configuración local

### 1. Instalar dependencias

```bash
npm install
```

### 2. Crear archivo `.env`

Copiar el archivo de ejemplo:

```bash
cp .env.example .env
```

En Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### 3. Configurar variables

Editar `.env`:

```env
FOOTBALL_DATA_TOKEN=tu_token_real
COMPETITION=WC
PORT=3000
POLL_MS=20000
CLOCK_ADMIN_SECRET=una_clave_larga_y_privada
```

### 4. Levantar el proyecto

```bash
npm start
```

Luego abrir:

```txt
http://localhost:3000
```

---

## Variables de entorno

| Variable | Descripción | Valor sugerido |
|---|---|---|
| `FOOTBALL_DATA_TOKEN` | Token privado de football-data.org | Token real |
| `COMPETITION` | Código de competencia | `WC` |
| `PORT` | Puerto local del servidor | `3000` |
| `POLL_MS` | Frecuencia de consulta a la API en milisegundos | `20000` |
| `CLOCK_ADMIN_SECRET` | Clave privada para usar endpoints administrativos del backend | Valor secreto largo |

> Importante: `POLL_MS` no debería bajarse demasiado para evitar problemas con límites de la API.
>
> `CLOCK_ADMIN_SECRET` no debe exponerse públicamente ni subirse al repositorio. Se usa para proteger acciones manuales como ajustar el reloj o marcador de un partido cuando la API externa viene desfasada.

---

## Seguridad

El archivo `.env` **no debe subirse al repositorio**.

El token real de football-data.org debe quedar únicamente en:

- El `.env` local de desarrollo.
- Las variables de entorno del proveedor de hosting.

Este proyecto usa `server.js` como proxy para que el token no quede expuesto en el navegador.

El endpoint administrativo `/admin/clock` está protegido mediante `CLOCK_ADMIN_SECRET`. Esa clave debe mantenerse privada y no debe compartirse públicamente.

El repositorio debe subir solamente:

```txt
.env.example
```

y nunca:

```txt
.env
```

---

## Endpoints

### Home

```txt
GET /
```

Sirve la app web desde `public/index.html`.

### Eventos SSE

```txt
GET /events
```

Canal de eventos en tiempo real para enviar snapshots y novedades al navegador.

Ejemplo de eventos enviados:

```txt
event: hello
data: {"hasToken":true,"competition":"WC","pollMs":15000}

event: snapshot
data: {...}
```

### Health check

```txt
GET /health
```

Devuelve el estado básico del servidor.

Ejemplo de respuesta:

```json
{
  "ok": true,
  "hasToken": true,
  "clients": 1,
  "lastSnapshot": true
}
```

### Ajuste manual de reloj y marcador

```txt
GET /admin/clock
```

Endpoint administrativo protegido por `CLOCK_ADMIN_SECRET`.

Permite ajustar manualmente el minuto de un partido en vivo y, opcionalmente, corregir el marcador cuando el proveedor externo viene desfasado.

#### Parámetros

| Parámetro | Obligatorio | Descripción |
|---|---:|---|
| `secret` | Sí | Debe coincidir con la variable de entorno `CLOCK_ADMIN_SECRET` |
| `minute` | Sí | Minuto real del partido. Debe estar entre `46` y `120` |
| `matchId` | No/Sí | ID del partido. Si hay un solo partido en vivo, puede omitirse. Si hay más de uno, es obligatorio |
| `home` | No | Goles del equipo local para override manual |
| `away` | No | Goles del equipo visitante para override manual |

#### Ejemplo: ajustar solo el minuto

```txt
/admin/clock?matchId=537412&minute=56&secret=TU_SECRET
```

#### Ejemplo: ajustar minuto y marcador

```txt
/admin/clock?matchId=537412&minute=56&home=0&away=1&secret=TU_SECRET
```

#### Respuesta esperada

```json
{
  "ok": true,
  "matchId": "537412",
  "minute": 56,
  "label": "~56'",
  "message": "Reloj/marcador ajustado manualmente"
}
```

> Este endpoint no reemplaza a la API oficial. Solo aplica correcciones manuales temporales en memoria cuando el feed externo viene atrasado.
>
> Si el servidor se reinicia o Render redeploya la app, los ajustes manuales se pierden porque se guardan en memoria.

---

## Deploy

### Opción recomendada

Deployar esta app como proyecto separado del catálogo principal.

Ejemplo:

```txt
Repositorio 1: catalogo
Repositorio 2: mundial-2026
```

El catálogo principal puede tener un botón que apunte a la URL pública de esta app.

Ejemplo:

```js
const MUNDIAL_URL = 'https://tu-app-mundial.netlify.app';
```

### Variables en producción

En Netlify, Render, Railway, Vercel u otro proveedor, cargar las variables desde el panel del hosting:

```txt
FOOTBALL_DATA_TOKEN
COMPETITION
PORT
POLL_MS
CLOCK_ADMIN_SECRET
```

No subir `.env` al repositorio.

---

## Integración con Bar Papelería

La app incluye llamadas comerciales para que el tráfico del Mundial también pueda convertirse en consultas por WhatsApp:

- Banner “Especial Mundial Bar Papelería”.
- Botón “Pedir por WhatsApp”.
- Botón “Ver catálogo”.
- Cards de productos mundialistas.
- CTA flotante de stickers mundialistas.

La intención es que el usuario pueda consultar novedades del Mundial y, al mismo tiempo, descubrir productos personalizados relacionados.

---

## Tracking

Si Google Analytics está cargado, la app puede registrar eventos como:

- `click_mundial_whatsapp_banner`
- `click_mundial_catalogo`
- `click_mundial_floating_cta`
- `click_mundial_producto`
- `click_back_to_top`

La implementación es segura porque verifica si `gtag` existe antes de llamar eventos.

---

## Scripts disponibles

```bash
npm start
```

Inicia el servidor.

```bash
npm run dev
```

Inicia el servidor en modo desarrollo. Actualmente ejecuta el mismo comando que `start`.

---

## Notas importantes

- Esta app no transmite partidos.
- No usa video ni streaming.
- No es una app de apuestas.
- El contenido comercial está pensado como complemento sutil de Bar Papelería.
- El token de la API debe mantenerse privado.
- Los ajustes manuales de `/admin/clock` son temporales y viven en memoria.
- Si el servidor se reinicia, los overrides manuales de reloj y marcador se pierden.
- El endpoint administrativo debe usarse solo para corregir desfases puntuales del proveedor externo.

---

## Marca

**Bar Papelería Personalizada**  
Papelería personalizada para cumpleaños, eventos, emprendimientos y detalles únicos.
