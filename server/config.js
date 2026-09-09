// Configuración por variables de entorno. Ninguna credencial vive en el código.
// En Render se configuran en Dashboard > Service > Environment.
// Para correr local, creá un archivo .env (está en .gitignore).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');

// Carga mínima de .env — sin dependencias. Las variables ya definidas en el
// entorno tienen prioridad (es lo que pasa en Render).
function cargarEnv() {
  const archivo = path.join(RAIZ, '.env');
  if (!fs.existsSync(archivo)) return;
  for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const i = limpia.indexOf('=');
    if (i === -1) continue;
    const clave = limpia.slice(0, i).trim();
    let valor = limpia.slice(i + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    if (process.env[clave] === undefined) process.env[clave] = valor;
  }
}
cargarEnv();

const num = (nombre, porDefecto) => {
  const v = Number.parseInt(process.env[nombre] ?? '', 10);
  return Number.isFinite(v) ? v : porDefecto;
};

export const config = {
  raiz: RAIZ,
  puerto: num('PORT', 3001),

  // --- Anthropic ---
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  modelo: process.env.CLAUDE_MODEL ?? 'claude-sonnet-5',
  maxTokens: num('MAX_TOKENS', 8000),
  // Cada vuelta del loop es una consulta DAX. Es la palanca principal de costo.
  maxVueltas: num('MAX_TOOL_ROUNDS', 14),

  // --- Autenticación del servicio ---
  // Sin esto, cualquiera con la URL de Render consume tu API key de Anthropic.
  appToken: process.env.APP_TOKEN ?? '',

  // --- Backend de datos: powerbi_service | agente_local | simulado ---
  backend: (process.env.DATA_BACKEND ?? 'powerbi_service').trim().toLowerCase(),

  // Modo A: Power BI Service (REST API executeQueries + Service Principal)
  pbi: {
    tenantId: process.env.PBI_TENANT_ID ?? '',
    clientId: process.env.PBI_CLIENT_ID ?? '',
    clientSecret: process.env.PBI_CLIENT_SECRET ?? '',
    workspaceId: process.env.PBI_WORKSPACE_ID ?? '',
    datasetId: process.env.PBI_DATASET_ID ?? '',
  },

  // Modo B: agente local junto a Power BI Desktop, expuesto por túnel
  agenteLocal: {
    url: (process.env.LOCAL_AGENT_URL ?? '').replace(/\/+$/, ''),
    token: process.env.LOCAL_AGENT_TOKEN ?? '',
  },

  // --- Límites de lo que se le manda al modelo ---
  maxFilasAlModelo: num('MAX_ROWS_TO_MODEL', 300),
  maxCaracteresAlModelo: num('MAX_CHARS_TO_MODEL', 60000),
  // Cuántos turnos de conversación acepta el servidor desde el navegador.
  maxTurnosHistorial: num('MAX_HISTORY_TURNS', 16),

  // Solo para desarrollo: sustituye la llamada a Anthropic por una respuesta fija,
  // para ver la interfaz sin gastar tokens. Nunca activar en producción.
  llmFalso: process.env.FAKE_LLM === '1',
};

export function variablesFaltantes() {
  const faltan = [];
  if (!config.anthropicApiKey && !config.llmFalso) faltan.push('ANTHROPIC_API_KEY');
  if (!config.appToken) faltan.push('APP_TOKEN');
  if (config.backend === 'powerbi_service') {
    const req = {
      PBI_TENANT_ID: config.pbi.tenantId,
      PBI_CLIENT_ID: config.pbi.clientId,
      PBI_CLIENT_SECRET: config.pbi.clientSecret,
      PBI_WORKSPACE_ID: config.pbi.workspaceId,
      PBI_DATASET_ID: config.pbi.datasetId,
    };
    for (const [k, v] of Object.entries(req)) if (!v) faltan.push(k);
  } else if (config.backend === 'agente_local') {
    if (!config.agenteLocal.url) faltan.push('LOCAL_AGENT_URL');
    if (!config.agenteLocal.token) faltan.push('LOCAL_AGENT_TOKEN');
  }
  return faltan;
}
