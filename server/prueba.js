// Pruebas de humo. Levantan el servidor real con el modelo simulado (FAKE_LLM=1)
// y el backend de datos simulado, así que NO gastan llamadas a la API de Anthropic
// ni necesitan credenciales.
//
//     npm test

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanearHistorial } from './agente.js';
import { DaxError, validarDax } from './powerbi.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PUERTO = 3999;
const BASE = `http://127.0.0.1:${PUERTO}`;
const TOKEN = 'token-de-prueba';

let fallas = 0;
function ok(cond, etiqueta) {
  if (cond) {
    console.log(`ok  ${etiqueta}`);
  } else {
    fallas += 1;
    console.error(`FALLA  ${etiqueta}`);
  }
}

// --- Pruebas que no necesitan el servidor ---------------------------------

function pruebasUnitarias() {
  validarDax('EVALUATE ROW("x",1)');
  validarDax('  define measure \'T\'[m] = 1 evaluate row("x",[m]) ');
  ok(true, 'validarDax acepta EVALUATE y DEFINE');

  let rechazadas = 0;
  for (const mala of ['', 'SELECT * FROM tabla', 'EVALUATE ROW("x",1) DROP TABLE t']) {
    try {
      validarDax(mala);
    } catch (err) {
      if (err instanceof DaxError) rechazadas += 1;
    }
  }
  ok(rechazadas === 3, 'validarDax rechaza consultas vacías, SELECT y palabras de escritura');

  // El historial que llega del navegador se limpia de basura
  const sucio = [
    { role: 'sistema', content: 'inyección' },
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: [{ type: 'text', text: 'qué tal' }, { type: 'raro', x: 1 }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
    null,
  ];
  const limpio = sanearHistorial(sucio);
  ok(
    limpio.length === 3 &&
      !limpio.some((m) => m.role === 'sistema') &&
      limpio[1].content.length === 1,
    'sanearHistorial descarta roles y bloques inválidos',
  );

  // Recorte por turnos: nunca debe empezar con un tool_result huérfano
  const largo = [];
  for (let i = 0; i < 30; i += 1) {
    largo.push({ role: 'user', content: `pregunta ${i}` });
    largo.push({ role: 'assistant', content: [{ type: 'text', text: 'r' }] });
    largo.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] });
  }
  const recortado = sanearHistorial(largo);
  ok(
    recortado[0].role === 'user' && typeof recortado[0].content === 'string',
    'sanearHistorial corta en un turno completo del usuario',
  );
}

// --- Pruebas contra el servidor -------------------------------------------

function arrancarServidor() {
  const hijo = spawn(process.execPath, [path.join(AQUI, 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PUERTO),
      APP_TOKEN: TOKEN,
      DATA_BACKEND: 'simulado',
      FAKE_LLM: '1',
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hijo.stderr.on('data', (d) => process.stderr.write(`[servidor] ${d}`));
  return hijo;
}

async function esperarServidor(intentos = 40) {
  for (let i = 0; i < intentos; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      /* todavía no está arriba */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const pedir = (ruta, opciones = {}) =>
  fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', ...(opciones.headers ?? {}) },
  });

async function pruebasHttp() {
  const salud = await (await pedir('/health')).json();
  ok(salud.estado === 'ok' && salud.backend === 'simulado', '/health responde sin token');

  ok((await pedir('/api/ask', { method: 'POST', body: '{"pregunta":"hola"}' })).status === 401,
    'rechaza pedidos sin token');

  ok(
    (
      await pedir('/api/ask', {
        method: 'POST',
        body: '{"pregunta":"hola"}',
        headers: { 'x-api-key': 'malo' },
      })
    ).status === 401,
    'rechaza token incorrecto',
  );

  const r = await pedir('/api/ask', {
    method: 'POST',
    headers: { 'x-api-key': TOKEN },
    body: JSON.stringify({ pregunta: '¿Cuál es el último día con datos?', historial: [] }),
  });
  const data = await r.json();
  ok(r.status === 200 && data.respuesta.includes('2026-09-08'), 'el loop responde con datos');
  ok(data.pasos.length === 1 && data.pasos[0].filas > 0 && !data.pasos[0].error,
    'ejecutó 1 consulta DAX y la registró como paso');
  ok(data.pasos[0].consulta.startsWith('EVALUATE'), 'el paso guarda el DAX que se ejecutó');
  ok(data.uso.tokens_entrada === 2400, 'contabiliza los tokens de las dos vueltas');
  ok(Array.isArray(data.historial) && data.historial.length === 4,
    'devuelve el historial para que lo guarde el navegador');

  // Segunda pregunta con el historial devuelto: el servidor no guarda nada,
  // así que el hilo tiene que reconstruirse desde el cliente.
  const r2 = await pedir('/api/ask', {
    method: 'POST',
    headers: { 'x-api-key': TOKEN },
    body: JSON.stringify({ pregunta: '¿y el anterior?', historial: data.historial }),
  });
  const data2 = await r2.json();
  ok(r2.status === 200 && data2.historial.length > data.historial.length,
    'el hilo continúa con el historial que manda el navegador (servicio sin estado)');

  ok((await pedir('/api/ask', { method: 'POST', headers: { 'x-api-key': TOKEN }, body: '{}' })).status === 400,
    'exige el campo pregunta');

  const rd = await pedir('/api/dax', {
    method: 'POST',
    headers: { 'x-api-key': TOKEN },
    body: JSON.stringify({ consulta: "EVALUATE VALUES('BaseEmpleado'[EMPLEADO])" }),
  });
  ok(rd.status === 200 && (await rd.json()).total === 2, '/api/dax devuelve filas');

  ok(
    (
      await pedir('/api/dax', {
        method: 'POST',
        headers: { 'x-api-key': TOKEN },
        body: JSON.stringify({ consulta: 'CREATE TABLE x' }),
      })
    ).status === 400,
    '/api/dax bloquea consultas que no son de lectura',
  );

  const diag = await (await pedir('/api/diagnostico', { headers: { 'x-api-key': TOKEN } })).json();
  ok(diag.powerbi?.ok === true, '/api/diagnostico verifica la conexión de datos');
}

// --- Ejecución ------------------------------------------------------------

pruebasUnitarias();

const servidor = arrancarServidor();
try {
  if (!(await esperarServidor())) {
    console.error('FALLA  el servidor no arrancó');
    fallas += 1;
  } else {
    await pruebasHttp();
  }
} finally {
  servidor.kill();
}

if (fallas > 0) {
  console.error(`\n${fallas} prueba(s) fallaron.`);
  process.exit(1);
}
console.log('\nTodas las pruebas pasaron.');
