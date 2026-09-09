// Interfaz de chat. El historial de la conversación vive acá, en memoria del
// navegador, y viaja al servidor en cada consulta — el servidor no guarda nada.
// Al recargar la página se empieza de cero: es a propósito, no hay persistencia.

import './estilos.css';
import { escapar, renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);

let TOKEN = '';
let historial = []; // mensajes en formato de la API, devueltos por el servidor
let ocupado = false;

const SUGERENCIAS = [
  '¿Quiénes fueron los mejores y peores alistadores de ayer?',
  'Demanda vs capacidad de COFERSA por proceso, en unidades y líneas',
  '¿Cómo viene la demanda de EPA Alisto normal esta semana?',
  'Ranking de alistadores de los últimos 30 días con su calificación',
];

// --- Token de acceso ------------------------------------------------------
// Lo único que se guarda en el navegador. Si el almacenamiento está bloqueado
// (ventana privada, política del navegador), el token se pide en cada visita.

function leerToken() {
  try {
    return localStorage.getItem('olo_token') ?? '';
  } catch {
    return '';
  }
}
function guardarToken(t) {
  try {
    localStorage.setItem('olo_token', t);
  } catch {
    /* sin almacenamiento: el token vive solo en esta pestaña */
  }
}
function borrarToken() {
  try {
    localStorage.removeItem('olo_token');
  } catch {
    /* nada que borrar */
  }
}

function entrar() {
  const t = $('tokenInput').value.trim();
  if (!t) return mostrarErrorLogin('Ingresá el token.');
  TOKEN = t;
  guardarToken(t);
  $('login').style.display = 'none';
  bienvenida();
  $('entrada').focus();
  return undefined;
}

function mostrarErrorLogin(m) {
  const e = $('loginError');
  e.textContent = m;
  e.style.display = 'block';
}

// --- Mensajes -------------------------------------------------------------

function agregarMensaje(quien, htmlCuerpo, clase = '') {
  const d = document.createElement('div');
  d.className = `msg ${clase}`;
  const enc = document.createElement('div');
  enc.className = 'quien';
  enc.textContent = quien;
  const cuerpo = document.createElement('div');
  cuerpo.className = 'burbuja';
  cuerpo.innerHTML = htmlCuerpo;
  d.append(enc, cuerpo);
  $('hilo').append(d);
  bajar();
  return d;
}

const bajar = () => {
  $('conversacion').scrollTop = $('conversacion').scrollHeight;
};

function bienvenida() {
  const d = agregarMensaje(
    'Copiloto',
    `<p>Consulto el modelo de expediciones directamente y respondo con datos reales, no estimados.
     Conozco la metodología ya validada: Alisto normal vs. Crossdock en EPA, los 5 procesos de
     Picking evaluados en conjunto para capacidad, y el ranking de alistadores.</p>
     <p>Siempre reporto unidades y líneas.</p>
     <div class="sugerencias"></div>`,
  );
  const caja = d.querySelector('.sugerencias');
  SUGERENCIAS.forEach((s) => {
    const b = document.createElement('button');
    b.textContent = s;
    b.addEventListener('click', () => {
      $('entrada').value = s;
      enviar();
    });
    caja.append(b);
  });
}

function nuevaConversacion() {
  historial = [];
  $('hilo').innerHTML = '';
  $('estadoPie').textContent = '';
  bienvenida();
}

const fmt = (n) => Number(n ?? 0).toLocaleString('es-CR');

async function enviar() {
  if (ocupado) return;
  const ta = $('entrada');
  const texto = ta.value.trim();
  if (!texto) return;
  ta.value = '';
  ta.style.height = 'auto';

  agregarMensaje('Ricardo', `<p>${escapar(texto).replace(/\n/g, '<br>')}</p>`, 'yo');

  ocupado = true;
  $('enviar').disabled = true;
  const espera = agregarMensaje(
    'Copiloto',
    '<div class="cargando"><span class="punto"></span><span class="punto"></span>' +
      '<span class="punto"></span><span class="reloj">Consultando el modelo…</span></div>',
  );
  const t0 = Date.now();
  const reloj = setInterval(() => {
    const s = espera.querySelector('.reloj');
    if (s) s.textContent = `Consultando el modelo… ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);

  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ pregunta: texto, historial }),
    });
    clearInterval(reloj);

    if (r.status === 401) {
      espera.remove();
      borrarToken();
      $('login').style.display = 'flex';
      mostrarErrorLogin('El token no es válido.');
      return;
    }

    const data = await r.json();
    const burbuja = espera.querySelector('.burbuja');

    if (!r.ok) {
      burbuja.innerHTML = `<div class="aviso"><b>No se pudo responder.</b><br>${escapar(
        data.error ?? `Error ${r.status}`,
      )}</div>`;
      return;
    }

    historial = data.historial ?? historial;

    let html = renderMarkdown(data.respuesta ?? '');
    if (data.truncado) {
      html +=
        '<div class="aviso" style="margin-top:10px">El análisis se cortó por el límite de ' +
        'consultas. Probá con una pregunta más acotada.</div>';
    }
    if (data.pasos?.length) {
      const n = data.pasos.length;
      html += `<details class="pasos"><summary>${n} consulta${n > 1 ? 's' : ''} al modelo · ${
        data.segundos
      }s</summary>`;
      data.pasos.forEach((p) => {
        html +=
          `<div class="paso"><div class="prop"><b>${escapar(p.proposito || 'Consulta')}</b> — ` +
          `${p.filas} fila${p.filas === 1 ? '' : 's'}</div>` +
          `<pre>${escapar(p.consulta)}</pre>` +
          (p.error ? `<div class="err">Error: ${escapar(p.error)}</div>` : '') +
          '</div>';
      });
      html += '</details>';
    }
    burbuja.innerHTML = html;

    $('estadoPie').textContent =
      `${fmt(data.uso?.tokens_entrada)} tokens de entrada · ` +
      `${fmt(data.uso?.tokens_salida)} de salida`;
  } catch (err) {
    clearInterval(reloj);
    espera.querySelector('.burbuja').innerHTML =
      `<div class="aviso"><b>Error de conexión.</b><br>${escapar(String(err))}</div>`;
  } finally {
    ocupado = false;
    $('enviar').disabled = false;
    bajar();
  }
}

async function verDiagnostico() {
  const d = agregarMensaje(
    'Diagnóstico',
    '<div class="cargando"><span class="punto"></span><span class="punto"></span>' +
      '<span class="punto"></span><span>Verificando…</span></div>',
  );
  try {
    const r = await fetch('/api/diagnostico', { headers: { 'x-api-key': TOKEN } });
    const data = await r.json();
    d.querySelector('.burbuja').innerHTML = `<pre>${escapar(JSON.stringify(data, null, 2))}</pre>`;
  } catch (err) {
    d.querySelector('.burbuja').innerHTML = `<div class="aviso">${escapar(String(err))}</div>`;
  }
  bajar();
}

// --- Arranque -------------------------------------------------------------

$('btnEntrar').addEventListener('click', entrar);
$('tokenInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') entrar();
});
$('btnNueva').addEventListener('click', nuevaConversacion);
$('btnDiag').addEventListener('click', verDiagnostico);
$('enviar').addEventListener('click', enviar);

const ta = $('entrada');
ta.addEventListener('input', () => {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 190)}px`;
});
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    enviar();
  }
});

TOKEN = leerToken();
if (TOKEN) {
  $('login').style.display = 'none';
  bienvenida();
}
