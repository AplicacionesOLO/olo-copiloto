// Servidor Express: sostiene la API key, corre el agente y sirve la interfaz.
//
// En desarrollo: Vite sirve la interfaz en :5173 y le manda /api a este servidor.
// En producción: este servidor sirve dist/ (el build de Vite) y las rutas /api
// desde el mismo puerto, así que en Render es un solo servicio.
//
// Sin estado: no hay base de datos, ni sesiones, ni nada guardado en disco. El
// historial de conversación vive en el navegador y viaja en cada llamada.

import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import compression from 'compression';
import express from 'express';

import { modelosDisponibles, preguntar } from './agente.js';
import { config, variablesFaltantes } from './config.js';
import { obtenerBackend } from './powerbi.js';

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// --- Autenticación ---------------------------------------------------------
// Un token compartido. Es lo único que separa la API key de Anthropic de
// internet, así que se compara en tiempo constante.

function tokenValido(entregado) {
  if (!entregado || !config.appToken) return false;
  const a = Buffer.from(String(entregado));
  const b = Buffer.from(config.appToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function autenticar(req, res, next) {
  if (!config.appToken) {
    return res.status(500).json({
      error:
        'El servicio no tiene APP_TOKEN configurado. Definilo en las variables de entorno ' +
        'antes de usarlo — si no, cualquiera con la URL puede consumir tu API key de Anthropic.',
    });
  }
  const cabecera = req.get('x-api-key');
  const bearer = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!tokenValido(cabecera) && !tokenValido(bearer)) {
    return res.status(401).json({ error: 'Token inválido o ausente.' });
  }
  return next();
}

// --- Rutas -----------------------------------------------------------------

app.get('/health', (_req, res) => {
  const faltan = variablesFaltantes();
  res.json({
    estado: faltan.length === 0 ? 'ok' : 'configuracion_incompleta',
    backend: config.backend,
    modelo: config.llmFalso ? 'FAKE_LLM (demo)' : config.modelo,
    faltan_variables: faltan,
  });
});

app.post('/api/ask', autenticar, async (req, res) => {
  const pregunta = String(req.body?.pregunta ?? req.body?.question ?? '').trim();
  if (!pregunta) return res.status(400).json({ error: "Falta el campo 'pregunta'." });
  if (pregunta.length > 8000) {
    return res.status(400).json({ error: 'La pregunta es demasiado larga.' });
  }

  const inicio = Date.now();
  try {
    const salida = await preguntar(pregunta, req.body?.historial);
    return res.json({ ...salida, segundos: Number(((Date.now() - inicio) / 1000).toFixed(2)) });
  } catch (err) {
    console.error('[ask]', err.message);
    return res.status(502).json({ error: err.message });
  }
});

// Consulta DAX directa, sin pasar por el modelo. Para integrar con Excel,
// Power Automate o cualquier cosa que ya sepa qué consulta necesita.
app.post('/api/dax', autenticar, async (req, res) => {
  const consulta = String(req.body?.consulta ?? req.body?.query ?? '').trim();
  if (!consulta) return res.status(400).json({ error: "Falta el campo 'consulta'." });
  try {
    const filas = await obtenerBackend().ejecutar(consulta);
    return res.json({ filas, total: filas.length });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/diagnostico', autenticar, async (_req, res) => {
  const salida = {
    backend_configurado: config.backend,
    modelo_configurado: config.llmFalso ? 'FAKE_LLM (demo)' : config.modelo,
    faltan_variables: variablesFaltantes(),
  };

  try {
    const modelos = await modelosDisponibles();
    salida.anthropic = {
      ok: true,
      modelos_disponibles: modelos,
      modelo_configurado_existe: modelos.includes(config.modelo),
    };
  } catch (err) {
    salida.anthropic = { ok: false, error: String(err.message).slice(0, 500) };
  }

  try {
    const backend = obtenerBackend();
    const filas = await backend.ejecutar('EVALUATE ROW("prueba", 1)');
    salida.powerbi = { ok: true, conexion: backend.descripcion(), resultado_prueba: filas };
  } catch (err) {
    salida.powerbi = { ok: false, error: String(err.message).slice(0, 800) };
  }

  res.json(salida);
});

// --- Interfaz (build de Vite) ---------------------------------------------

const dist = path.join(config.raiz, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res
      .status(200)
      .type('text/plain')
      .send(
        'La interfaz no está compilada todavía.\n\n' +
          'En desarrollo abrí http://localhost:5173 (Vite).\n' +
          'Para producción corré: npm run build\n',
      ),
  );
}

app.listen(config.puerto, () => {
  const faltan = variablesFaltantes();
  console.log(`Copiloto Outbound escuchando en http://localhost:${config.puerto}`);
  console.log(`  backend de datos: ${config.backend}`);
  if (config.llmFalso) console.log('  MODO DEMO: la respuesta del modelo es simulada (FAKE_LLM=1)');
  if (faltan.length) console.log(`  faltan variables de entorno: ${faltan.join(', ')}`);
});
