# Copiloto Outbound OLO

Aplicación web que hace lo mismo que la sesión de chat con Claude: le preguntás en
español, consulta el modelo semántico de Power BI con DAX, y responde con datos
reales. Trae integrada la metodología ya validada de la operación (Alisto normal
vs. Crossdock, capacidad de los 5 procesos de Picking evaluados en conjunto,
ranking de alistadores) y siempre reporta unidades y líneas.

**Stack:** Vite + JavaScript en el frontend, Express en el backend. Un solo
servicio en Render.

**No almacena datos.** No hay base de datos ni sesiones en el servidor. El
historial de la conversación vive en el navegador y viaja en cada consulta; el
servidor lo usa y lo olvida. Al recargar la página se empieza de cero.

---

## Por qué hay un backend y no solo HTML

La API key **no puede vivir en el frontend**. Todo lo que Vite compila termina en
el navegador: cualquiera que abra la página y mire el código fuente vería la key y
podría gastarla. Aparte, la API de Anthropic bloquea las llamadas desde el
navegador por diseño, justamente para evitar eso.

Así que Vite construye la interfaz y un servidor Express mínimo hace tres cosas:
guarda la API key, corre el loop de consultas, y sirve los archivos que Vite
compiló. Para vos es un solo servicio en Render y un solo `npm start` — el backend
no agrega infraestructura, solo mantiene la key del lado seguro.

---

## Cómo llega al dato: dos modos

**Render no puede ver tu Power BI Desktop.** Render corre en la nube; tu archivo
`.pbix` corre en tu computadora, en un motor que solo escucha en `localhost` y ni
habla HTTP. De ahí que existan dos caminos, y se elige con una variable de entorno:

| | Modo A — Power BI Service | Modo B — Agente local |
|---|---|---|
| Cómo consulta | REST API `executeQueries` sobre el dataset publicado, con Service Principal de Azure AD | Un agente en tu máquina ejecuta el DAX contra Power BI Desktop, expuesto por túnel HTTPS |
| Disponibilidad | 24/7, no depende de tu computadora | Solo con tu computadora encendida, el archivo abierto y el túnel activo |
| Requisitos | Dataset publicado, App Registration, permisos de tenant | Windows, Python, cloudflared |
| Trámite | Con quien administre Microsoft en OLO | Ninguno |

`DATA_BACKEND=powerbi_service` o `DATA_BACKEND=agente_local`. Hay un tercer valor,
`simulado`, que devuelve datos de prueba y sirve para validar el despliegue sin
credenciales.

Recomendación: arrancá en modo B para usarlo esta semana y gestioná el A en
paralelo para dejarlo estable.

---

## Lo que necesitás tener a mano

### Siempre

1. **Una API key de Anthropic** (console.anthropic.com → API Keys). Se escribe
   directamente en las variables de entorno de Render — nunca en el código, nunca
   por chat. Si alguna vez se filtra, se revoca y se crea otra; es lo único que hay
   que hacer.
2. **Una cuenta de Render** (el plan gratuito sirve para probar).
3. **Un token de acceso propio**: cualquier cadena larga y aleatoria que inventes.
   Es lo que protege el servicio. Generá una con:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

### Si vas por el modo A (Power BI Service)

4. El **dataset publicado** en un workspace de Power BI Service — no en "Mi área de
   trabajo", porque los Service Principals no pueden leer ahí.
5. Un **App Registration en Azure AD** con su *client secret*: de ahí salen
   **Tenant ID**, **Client ID** y **Client Secret**.
6. Ese Service Principal como **miembro del workspace** (rol Viewer alcanza).
7. Dos **settings de tenant de Power BI** habilitados por el administrador, en el
   portal de administración → Configuración del inquilino:
   - *Allow service principals to use Power BI APIs*
   - *Dataset Execute Queries REST API*
8. Los **IDs de workspace y dataset**, que salen de la URL al abrir el dataset:
   `.../groups/<WORKSPACE_ID>/datasets/<DATASET_ID>/...`

Los puntos 5, 6 y 7 los tiene que hacer quien administre Microsoft 365 / Azure en
OLO. Es trámite de una vez.

### Si vas por el modo B (agente local)

4. Windows con Power BI Desktop abierto y el archivo cargado, y Python instalado.
5. **cloudflared** para el túnel (`winget install Cloudflare.cloudflared`).
6. Otro token aleatorio, distinto al del punto 3, para que Render y el agente se
   reconozcan.

---

## Despliegue en Render

1. Subí esta carpeta a un repositorio de GitHub **privado**.
2. En Render: **New → Web Service**, conectá el repositorio.
3. Configuración:
   - Runtime: **Node**
   - Build command: `npm ci && npm run build`
   - Start command: `npm start`
   - Health check path: `/health`
4. En **Environment**, agregá las variables (la lista completa está en
   `.env.example`):

   | Variable | Qué poner |
   |---|---|
   | `ANTHROPIC_API_KEY` | tu API key |
   | `APP_TOKEN` | el token aleatorio que inventaste |
   | `DATA_BACKEND` | `powerbi_service`, `agente_local` o `simulado` |
   | `CLAUDE_MODEL` | opcional; por defecto `claude-sonnet-5` |

   Modo A además: `PBI_TENANT_ID`, `PBI_CLIENT_ID`, `PBI_CLIENT_SECRET`,
   `PBI_WORKSPACE_ID`, `PBI_DATASET_ID`.
   Modo B además: `LOCAL_AGENT_URL` (la URL del túnel) y `LOCAL_AGENT_TOKEN`.

5. Deploy. Abrí la URL, ingresá tu `APP_TOKEN` y listo.

Con **New → Blueprint** Render lee `render.yaml`, crea el servicio solo y te pide
únicamente los secretos.

**Probá primero con `DATA_BACKEND=simulado`**: devuelve datos de prueba y te
confirma que el despliegue, el token y la interfaz funcionan antes de pelear con
credenciales de Power BI. Después, el botón **Diagnóstico** de la interfaz te dice
exactamente qué está bien y qué falta — si la API key sirve, si el modelo
configurado existe, y si la conexión a Power BI responde.

---

## Desarrollo local

```bash
npm install
cp .env.example .env      # editá los valores
npm run dev               # Vite en :5173 + API en :3001
```

Vite le manda a Express todo lo que empiece con `/api`, así que trabajás siempre
en `http://localhost:5173` con recarga en caliente.

Para ver la interfaz sin API key ni credenciales:

```bash
npm run demo              # modelo y datos simulados, token: demo
```

Otros comandos:

```bash
npm test                  # pruebas de humo (no gastan API)
npm run build             # compila la interfaz a dist/
npm start                 # sirve dist/ + /api en un solo puerto (lo que corre en Render)
```

---

## La API

La interfaz usa los mismos endpoints, así que podés integrarlo con Excel, Power
Automate o cualquier otra herramienta.

```bash
curl -X POST https://tu-servicio.onrender.com/api/ask \
  -H "Content-Type: application/json" \
  -H "x-api-key: TU_APP_TOKEN" \
  -d '{"pregunta": "¿Quiénes fueron los peores alistadores de ayer?"}'
```

Respuesta:

```json
{
  "respuesta": "…texto en markdown…",
  "pasos": [{ "proposito": "…", "consulta": "EVALUATE …", "filas": 47, "error": null }],
  "historial": [{ "role": "user", "content": "…" }],
  "uso": { "tokens_entrada": 12400, "tokens_salida": 980 },
  "segundos": 18.4
}
```

Para continuar una conversación, mandá de vuelta el `historial` que te devolvió —
el servidor no lo recuerda por su cuenta.

| Método y ruta | Para qué |
|---|---|
| `POST /api/ask` | Pregunta en lenguaje natural |
| `POST /api/dax` | Ejecutar una consulta DAX directa, sin pasar por el modelo |
| `GET /api/diagnostico` | Verificar configuración y conexiones |
| `GET /health` | Estado del servicio (sin token) |

Todos los `/api/*` piden el header `x-api-key` (también acepta
`Authorization: Bearer`).

---

## Arrancar el agente local (modo B)

En tu máquina, con Power BI Desktop abierto:

```bat
cd agente-local
pip install -r requirements.txt
set AGENT_TOKEN=el-mismo-valor-que-LOCAL_AGENT_TOKEN-en-Render
python agente_local.py
```

En otra terminal:

```bat
cloudflared tunnel --url http://localhost:8787
```

Cloudflared imprime una URL `https://algo.trycloudflare.com`: esa va en
`LOCAL_AGENT_URL` en Render. La URL gratuita **cambia cada vez que reiniciás el
túnel**, así que hay que actualizar la variable cada vez; un túnel con nombre
propio (requiere un dominio en Cloudflare) evita ese trámite.

El agente está en Python porque necesita ADOMD.NET para hablar con Power BI
Desktop, y no hay una librería equivalente para Node. Es la única pieza que no es
JavaScript, corre solo en tu máquina, y no se despliega a Render.

---

## Seguridad

- Ninguna credencial vive en el código; todo sale de variables de entorno.
- El servicio es de **solo lectura**: se valida que cada consulta empiece con
  `EVALUATE` o `DEFINE` y se rechaza cualquier palabra de escritura o
  administración. No puede modificar el modelo ni borrar nada.
- El `APP_TOKEN` se compara en tiempo constante y es lo único que separa tu API key
  de internet. Que sea largo y aleatorio.
- El historial que manda el navegador se valida antes de reenviarlo a la API: se
  descartan roles y tipos de bloque que no correspondan.
- El repositorio debe ser **privado**: aunque no contenga secretos, el system
  prompt describe la estructura interna de la operación.
- Nada se guarda en disco ni en memoria del servidor entre consultas.

---

## Costos

**Render.** El plan gratuito duerme el servicio tras unos minutos de inactividad;
la primera pregunta después tarda ~30-50 segundos en despertar. El plan Starter lo
mantiene despierto.

**API de Anthropic.** Se cobra por token. Cada pregunta consume el system prompt
(~4.000 tokens de contexto de la operación), más los resultados de cada consulta
DAX, más la respuesta — una pregunta típica con 3-4 consultas ronda los 15-25 mil
tokens de entrada. Los precios vigentes están en
<https://www.anthropic.com/pricing>; conviene poner un límite de gasto mensual en
la consola de Anthropic antes de dejarlo abierto.

`MAX_TOOL_ROUNDS` (cuántas consultas DAX por pregunta) y `MAX_HISTORY_TURNS`
(cuánta conversación se reenvía) son las dos palancas de consumo.

---

## Mantenimiento

Todo el conocimiento de la operación está en **`server/prompt.js`**. Si cambia el
modelo —medidas nuevas, otro proceso, otra compañía, una corrección
metodológica— se edita ese archivo y se vuelve a desplegar. No hay lógica de
negocio repartida en otros lados.

Lo que ya sabe está tomado de los documentos del proyecto "Outbound OLO":
`analisis-demanda-vs-capacidad-outbound.md` y
`ranking-alistadores-productividad.md`. Cuando esos se actualicen, vale revisar si
el prompt necesita el mismo cambio.

---

## Estructura

```
olo-copiloto/
├── index.html              entrada de Vite
├── src/
│   ├── main.js             lógica del chat (el historial vive acá)
│   ├── markdown.js         renderizador de markdown, sin dependencias
│   └── estilos.css         marca OLO (verde #00A885, Arial)
├── server/
│   ├── index.js            Express: /api + sirve dist/
│   ├── agente.js           loop pregunta → consultas DAX → respuesta
│   ├── powerbi.js          los tres backends de datos
│   ├── prompt.js           metodología de la operación (editar acá)
│   ├── config.js           variables de entorno
│   └── prueba.js           pruebas de humo
├── agente-local/           agente para Power BI Desktop (modo B, Python)
├── vite.config.js
├── render.yaml             blueprint de Render
└── .env.example
```
