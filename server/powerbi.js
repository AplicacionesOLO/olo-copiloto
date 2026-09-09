// Backends de datos: cómo llega una consulta DAX al modelo semántico.
//
//   powerbi_service  El dataset está publicado en Power BI Service. Se consulta con
//                    la REST API (executeQueries) autenticando con un Service
//                    Principal de Azure AD. Único modo que funciona sin depender de
//                    que la computadora de Ricardo esté encendida.
//
//   agente_local     El modelo vive en Power BI Desktop. Un agente local (carpeta
//                    agente-local/) ejecuta el DAX y se expone por un túnel HTTPS.
//
//   simulado         Datos de prueba, para validar el despliegue sin credenciales.
//
// Todos son de SOLO LECTURA: se valida que el DAX sea una consulta y se rechaza
// cualquier cosa que intente modificar el modelo.

import { ConfidentialClientApplication } from '@azure/msal-node';

import { config } from './config.js';

const PBI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
const PBI_API = 'https://api.powerbi.com/v1.0/myorg';

const PROHIBIDO =
  /\b(CREATE|ALTER|DROP|DELETE|INSERT|UPDATE|MERGE|REFRESH|BACKUP|RESTORE|ATTACH|DETACH|PROCESS|EXECUTE|CALL)\b/i;

export class DaxError extends Error {}

export function validarDax(consulta) {
  const q = (consulta ?? '').trim();
  if (!q) throw new DaxError('La consulta está vacía.');
  // Quitar comentarios antes de validar, para no disparar falsos positivos
  const limpia = q.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (!/^\s*(EVALUATE|DEFINE)\b/i.test(limpia)) {
    throw new DaxError(
      'Solo se aceptan consultas de lectura que empiecen con EVALUATE o DEFINE. ' +
        'Este servicio no puede modificar el modelo.',
    );
  }
  if (PROHIBIDO.test(limpia)) {
    throw new DaxError(
      'La consulta contiene una palabra reservada de escritura o administración. ' +
        'Este servicio es de solo lectura.',
    );
  }
  return q;
}

// 'Tabla[Columna]' -> 'Columna', salvo que al acortar dos columnas colisionen.
function normalizarFilas(filas) {
  if (!Array.isArray(filas) || filas.length === 0) return filas ?? [];
  const originales = Object.keys(filas[0]);
  const conteo = {};
  const corto = (col) => (col.includes('[') ? col.slice(col.indexOf('[') + 1).replace(/\]$/, '') : col);
  for (const col of originales) {
    const c = corto(col);
    conteo[c] = (conteo[c] ?? 0) + 1;
  }
  const mapa = {};
  for (const col of originales) {
    const c = corto(col);
    mapa[col] = conteo[c] > 1 ? col : c;
  }
  return filas.map((fila) => {
    const salida = {};
    for (const [k, v] of Object.entries(fila)) salida[mapa[k] ?? k] = v;
    return salida;
  });
}

class PowerBIService {
  nombre = 'powerbi_service';

  constructor() {
    this.msal = new ConfidentialClientApplication({
      auth: {
        clientId: config.pbi.clientId,
        authority: `https://login.microsoftonline.com/${config.pbi.tenantId}`,
        clientSecret: config.pbi.clientSecret,
      },
    });
  }

  descripcion() {
    return `Power BI Service — workspace ${config.pbi.workspaceId}, dataset ${config.pbi.datasetId}`;
  }

  async token() {
    let res;
    try {
      // msal-node cachea el token internamente y lo renueva cuando expira
      res = await this.msal.acquireTokenByClientCredential({ scopes: [PBI_SCOPE] });
    } catch (err) {
      throw new DaxError(
        'No se pudo autenticar contra Azure AD. Revisá PBI_TENANT_ID / PBI_CLIENT_ID / ' +
          `PBI_CLIENT_SECRET. Detalle: ${err.message}`,
      );
    }
    if (!res?.accessToken) throw new DaxError('Azure AD no devolvió un token de acceso.');
    return res.accessToken;
  }

  async ejecutar(consulta) {
    const q = validarDax(consulta);
    const url = `${PBI_API}/groups/${config.pbi.workspaceId}/datasets/${config.pbi.datasetId}/executeQueries`;
    const token = await this.token();

    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 180000);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: [{ query: q }],
          serializerSettings: { includeNulls: true },
        }),
        signal: control.signal,
      });
    } catch (err) {
      throw new DaxError(
        err.name === 'AbortError'
          ? 'La consulta a Power BI tardó más de 3 minutos y se canceló. Probá con una consulta más liviana.'
          : `Error de red consultando Power BI: ${err.message}`,
      );
    } finally {
      clearTimeout(reloj);
    }

    if (resp.status === 401) {
      throw new DaxError(
        'Power BI rechazó la autenticación (401). El Service Principal necesita acceso al ' +
          'workspace y el tenant debe permitir que los service principals usen las APIs de Power BI.',
      );
    }
    if (resp.status === 403) {
      throw new DaxError(
        'Power BI devolvió 403. Suele ser una de dos cosas: el Service Principal no es miembro ' +
          "del workspace, o el setting de tenant 'Dataset Execute Queries REST API' está deshabilitado.",
      );
    }
    if (!resp.ok) {
      const detalle = (await resp.text()).slice(0, 1500);
      throw new DaxError(`Power BI devolvió ${resp.status}: ${detalle}`);
    }

    const data = await resp.json();
    const filas = data?.results?.[0]?.tables?.[0]?.rows;
    if (!Array.isArray(filas)) {
      throw new DaxError(`Respuesta inesperada de Power BI: ${JSON.stringify(data).slice(0, 800)}`);
    }
    return normalizarFilas(filas);
  }
}

class AgenteLocal {
  nombre = 'agente_local';

  descripcion() {
    return `Agente local en ${config.agenteLocal.url}`;
  }

  async ejecutar(consulta) {
    const q = validarDax(consulta);
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 180000);
    let resp;
    try {
      resp = await fetch(`${config.agenteLocal.url}/dax`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': config.agenteLocal.token },
        body: JSON.stringify({ consulta: q }),
        signal: control.signal,
      });
    } catch (err) {
      throw new DaxError(
        'No se pudo contactar el agente local. Verificá que Power BI Desktop esté abierto, el ' +
          `agente corriendo y el túnel activo. Detalle: ${err.message}`,
      );
    } finally {
      clearTimeout(reloj);
    }
    if (resp.status === 401) {
      throw new DaxError('El agente local rechazó el token (LOCAL_AGENT_TOKEN no coincide).');
    }
    if (!resp.ok) {
      throw new DaxError(`El agente local devolvió ${resp.status}: ${(await resp.text()).slice(0, 1000)}`);
    }
    const data = await resp.json();
    if (!data?.ok) throw new DaxError(String(data?.error ?? 'Error desconocido del agente local').slice(0, 1500));
    return normalizarFilas(data.filas ?? []);
  }
}

class Simulado {
  nombre = 'simulado';

  descripcion() {
    return 'MODO SIMULADO — los datos no son reales';
  }

  async ejecutar(consulta) {
    const q = validarDax(consulta).toUpperCase();
    if (q.includes('MAX(') && q.includes('FECHA')) {
      return [{ MaxFecha: '2026-09-08T00:00:00' }];
    }
    if (q.includes('INFO.') || q.includes('MEASURES')) {
      return [
        { Tabla: 'Kpi Productividad y Eficiencia CR', Medida: 'Capacidad Estimada Líneas (equipo)' },
        { Tabla: 'Kpi Productividad y Eficiencia CR', Medida: 'Productividad Líneas' },
        { Tabla: 'ExpedicionesContraInventario', Medida: 'Pedidas reales' },
      ];
    }
    return [
      { ID_USUARIO: '1033', Nombre: 'DEMO UNO', Horas: 8.2, Unidades: 1980, Lineas: 141 },
      { ID_USUARIO: '1037', Nombre: 'DEMO DOS', Horas: 7.4, Unidades: 1210, Lineas: 96 },
    ];
  }
}

let backend = null;

export function obtenerBackend() {
  if (backend) return backend;
  if (config.backend === 'powerbi_service') backend = new PowerBIService();
  else if (config.backend === 'agente_local') backend = new AgenteLocal();
  else if (config.backend === 'simulado') backend = new Simulado();
  else {
    throw new Error(
      `DATA_BACKEND='${config.backend}' no es válido. Usá powerbi_service, agente_local o simulado.`,
    );
  }
  return backend;
}
