// El loop del agente: pregunta -> consultas DAX -> respuesta.
//
// Es SIN ESTADO. El historial de la conversación lo manda el navegador en cada
// llamada y se devuelve actualizado; el servidor no guarda nada, ni en memoria ni
// en disco. Eso también significa que el historial es dato que viene del cliente,
// así que se valida y se acota antes de reenviarlo a la API.

import Anthropic from '@anthropic-ai/sdk';

import { config } from './config.js';
import { DaxError, obtenerBackend } from './powerbi.js';
import { SYSTEM_PROMPT, TOOLS } from './prompt.js';

let cliente = null;

function obtenerCliente() {
  if (cliente) return cliente;
  if (config.llmFalso) {
    cliente = clienteFalso();
    return cliente;
  }
  if (!config.anthropicApiKey) {
    throw new Error('Falta ANTHROPIC_API_KEY en las variables de entorno.');
  }
  cliente = new Anthropic({ apiKey: config.anthropicApiKey });
  return cliente;
}

// --- Formateo de resultados para el modelo ---------------------------------

function formatearResultado(filas) {
  const total = filas.length;
  if (total === 0) return 'La consulta se ejecutó correctamente pero no devolvió filas.';

  let recorte = filas.slice(0, config.maxFilasAlModelo);
  let texto = JSON.stringify(recorte);
  while (recorte.length > 1 && texto.length > config.maxCaracteresAlModelo) {
    recorte = recorte.slice(0, Math.floor(recorte.length / 2));
    texto = JSON.stringify(recorte);
  }

  let cabecera = `${total} filas devueltas`;
  if (recorte.length < total) {
    cabecera +=
      `; se muestran las primeras ${recorte.length}. Si necesitás el resto, agregá ` +
      'agregaciones, TOPN o filtros a la consulta en vez de traer todo';
  }
  return `${cabecera}.\n${texto}`;
}

async function ejecutarHerramienta(entrada) {
  const consulta = entrada?.consulta ?? '';
  const proposito = entrada?.proposito || 'Consulta al modelo';
  try {
    const filas = await obtenerBackend().ejecutar(consulta);
    return {
      salida: formatearResultado(filas),
      paso: { proposito, consulta, filas: filas.length, error: null },
      error: false,
    };
  } catch (err) {
    const msg = err instanceof DaxError ? err.message : `Error inesperado: ${err.message}`;
    return {
      salida: `ERROR: ${msg}`,
      paso: { proposito, consulta, filas: 0, error: msg },
      error: true,
    };
  }
}

// --- Validación del historial que llega del navegador ---------------------

const BLOQUES_VALIDOS = new Set(['text', 'tool_use', 'tool_result']);

export function sanearHistorial(historial) {
  if (!Array.isArray(historial)) return [];
  const limpio = [];
  for (const msg of historial) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const c = msg.content;
    if (typeof c === 'string') {
      limpio.push({ role: msg.role, content: c.slice(0, 20000) });
      continue;
    }
    if (!Array.isArray(c)) continue;
    const bloques = c.filter((b) => b && typeof b === 'object' && BLOQUES_VALIDOS.has(b.type));
    if (bloques.length) limpio.push({ role: msg.role, content: bloques });
  }
  // Quedarse con los últimos N turnos del usuario, cortando en un turno completo
  // para no dejar un tool_result huérfano al inicio.
  const esTurnoUsuario = (m) =>
    m.role === 'user' &&
    (typeof m.content === 'string' || !m.content.some((b) => b.type === 'tool_result'));
  const indices = limpio.map((m, i) => (esTurnoUsuario(m) ? i : -1)).filter((i) => i >= 0);
  if (indices.length > config.maxTurnosHistorial) {
    return limpio.slice(indices[indices.length - config.maxTurnosHistorial]);
  }
  return limpio;
}

// --- Loop principal --------------------------------------------------------

export async function preguntar(pregunta, historialEntrante) {
  const api = obtenerCliente();
  const mensajes = [...sanearHistorial(historialEntrante), { role: 'user', content: pregunta }];

  const pasos = [];
  let tokensEntrada = 0;
  let tokensSalida = 0;
  let texto = '';
  let truncado = false;

  for (let vuelta = 0; vuelta < config.maxVueltas; vuelta += 1) {
    let resp;
    try {
      resp = await api.messages.create({
        model: config.modelo,
        max_tokens: config.maxTokens,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: mensajes,
      });
    } catch (err) {
      if (err?.status === 404) {
        throw new Error(
          `El modelo '${config.modelo}' no existe o no está disponible para esta API key. ` +
            'Cambiá la variable CLAUDE_MODEL. Podés ver los modelos disponibles en GET /api/diagnostico.',
        );
      }
      if (err?.status === 401) {
        throw new Error('La API key de Anthropic fue rechazada. Revisá ANTHROPIC_API_KEY.');
      }
      if (err?.status === 429) {
        throw new Error('La API de Anthropic está limitando el ritmo (429). Esperá unos segundos y reintentá.');
      }
      throw new Error(`Error llamando a la API de Anthropic: ${err.message}`);
    }

    tokensEntrada += resp.usage?.input_tokens ?? 0;
    tokensSalida += resp.usage?.output_tokens ?? 0;

    // Guardar la respuesta tal cual, para mantener el hilo de la conversación
    mensajes.push({ role: 'assistant', content: resp.content });

    const usos = resp.content.filter((b) => b.type === 'tool_use');
    if (usos.length === 0) {
      texto = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    // Las consultas de una misma vuelta se ejecutan en secuencia: Power BI acepta
    // una consulta por request y así los pasos quedan en orden para el usuario.
    const resultados = [];
    for (const uso of usos) {
      if (uso.name !== 'ejecutar_dax') {
        resultados.push({
          type: 'tool_result',
          tool_use_id: uso.id,
          content: `ERROR: herramienta desconocida '${uso.name}'.`,
          is_error: true,
        });
        continue;
      }
      const { salida, paso, error } = await ejecutarHerramienta(uso.input);
      pasos.push(paso);
      resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: salida, is_error: error });
    }
    mensajes.push({ role: 'user', content: resultados });

    if (vuelta === config.maxVueltas - 1) {
      truncado = true;
      texto =
        `Me quedé sin vueltas de consulta antes de terminar el análisis (límite: ${config.maxVueltas} ` +
        'consultas). Probá con una pregunta más acotada, o subí MAX_TOOL_ROUNDS si estas preguntas ' +
        'largas son habituales.';
    }
  }

  if (!texto) texto = '(El modelo no devolvió texto en la respuesta final.)';

  return {
    respuesta: texto,
    pasos,
    historial: mensajes,
    uso: { tokens_entrada: tokensEntrada, tokens_salida: tokensSalida },
    truncado,
  };
}

export async function modelosDisponibles() {
  const api = obtenerCliente();
  const lista = await api.models.list({ limit: 50 });
  return lista.data.map((m) => m.id);
}

// --- Cliente falso, solo para `npm run demo` -------------------------------

function clienteFalso() {
  let vueltas = 0;
  const RESPUESTA = `El último día con datos en el modelo es el **2026-09-08**. Sobre ese día, el ranking de alistadores con turno completo queda así — reporto unidades y líneas, más el índice relativo de cada uno contra el equipo regular.

| Alistador | Horas | Unidades | Líneas | Unid/hora | Líneas/hora | Índice unid. | Índice líneas | Eficiencia | Puntaje |
|---|---|---|---|---|---|---|---|---|---|
| DEMO UNO | 8,2 | 1.980 | 141 | 241,5 | 17,2 | 118,4 | 112,0 | 96,5 | 88,1 |
| DEMO DOS | 7,4 | 1.210 | 96 | 163,5 | 13,0 | 80,2 | 84,6 | 87,1 | 61,4 |

La diferencia entre los dos es de ritmo, no de asistencia: ambos cubrieron prácticamente todo el turno, pero DEMO DOS trabajó a un 80% del ritmo del equipo regular en unidades. Vale preguntarle qué lo frenó ese día antes de asumir la causa.

*(Respuesta de demostración: el servidor corre con el modelo simulado, no consultó nada real.)*`;

  return {
    messages: {
      async create() {
        vueltas += 1;
        const usage = { input_tokens: 1200, output_tokens: 480 };
        if (vueltas % 2 === 1) {
          return {
            usage,
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: `tu_${vueltas}`,
                name: 'ejecutar_dax',
                input: {
                  proposito: 'Traer horas y producción por alistador del último día',
                  consulta:
                    'EVALUATE\nVAR _Dia = DATE(2026,9,8)\n' +
                    "VAR _Personas = CALCULATETABLE(VALUES('Kpi Productividad y Eficiencia CR'[ID_USUARIO]),\n" +
                    "    'Kpi Productividad y Eficiencia CR'[Fecha] = _Dia)\n" +
                    'RETURN ADDCOLUMNS(_Personas, "Horas", CALCULATE([Horas laboradas]))',
                },
              },
            ],
          };
        }
        return { usage, stop_reason: 'end_turn', content: [{ type: 'text', text: RESPUESTA }] };
      },
    },
    models: {
      async list() {
        return { data: [{ id: 'modelo-falso-de-demo' }] };
      },
    },
  };
}
