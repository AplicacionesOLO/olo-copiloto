// Renderizador de markdown mínimo, sin dependencias: párrafos, encabezados,
// listas, tablas, código en bloque y en línea, negrita, cursiva y enlaces.
// Todo se escapa antes de armar el HTML, así que la respuesta del modelo nunca
// puede inyectar etiquetas.

export function escapar(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function enLinea(t) {
  let s = escapar(t);
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return s;
}

// Una columna se alinea a la derecha si todos sus valores parecen números
// (admite separadores de miles, decimales con coma, %, paréntesis de negativos).
const esNumero = (c) => /^-?[\d.,\s%$()+]+$/.test(String(c).trim()) && /\d/.test(String(c));

const esSepTabla = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes('-');
const celdas = (l) =>
  l
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());

export function renderMarkdown(md) {
  const lineas = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let html = '';
  let i = 0;

  while (i < lineas.length) {
    const linea = lineas[i];

    // Bloque de código
    if (/^\s*```/.test(linea)) {
      i += 1;
      const code = [];
      while (i < lineas.length && !/^\s*```/.test(lineas[i])) {
        code.push(lineas[i]);
        i += 1;
      }
      i += 1;
      html += `<pre><code>${escapar(code.join('\n'))}</code></pre>`;
      continue;
    }

    if (!linea.trim()) {
      i += 1;
      continue;
    }

    // Encabezado
    const h = linea.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length + 1, 4);
      html += `<h${n}>${enLinea(h[2])}</h${n}>`;
      i += 1;
      continue;
    }

    // Línea horizontal: se ignora
    if (/^\s*(---|\*\*\*|___)\s*$/.test(linea)) {
      i += 1;
      continue;
    }

    // Tabla
    if (linea.includes('|') && i + 1 < lineas.length && esSepTabla(lineas[i + 1])) {
      const enc = celdas(linea);
      i += 2;
      const filas = [];
      while (i < lineas.length && lineas[i].includes('|') && lineas[i].trim()) {
        filas.push(celdas(lineas[i]));
        i += 1;
      }
      const numerica = enc.map(
        (_e, c) => filas.length > 0 && filas.every((f) => !f[c] || esNumero(f[c])),
      );
      html += '<div class="tabla-scroll"><table><thead><tr>';
      enc.forEach((e, c) => {
        html += `<th class="${numerica[c] ? 'num' : ''}">${enLinea(e)}</th>`;
      });
      html += '</tr></thead><tbody>';
      filas.forEach((f) => {
        html += '<tr>';
        enc.forEach((_e, c) => {
          html += `<td class="${numerica[c] ? 'num' : ''}">${enLinea(f[c] ?? '')}</td>`;
        });
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      continue;
    }

    // Listas
    const esVineta = (l) => /^\s*[-*+]\s+/.test(l);
    const esNumerada = (l) => /^\s*\d+[.)]\s+/.test(l);
    if (esVineta(linea) || esNumerada(linea)) {
      const tag = esNumerada(linea) ? 'ol' : 'ul';
      html += `<${tag}>`;
      while (i < lineas.length && (esVineta(lineas[i]) || esNumerada(lineas[i]))) {
        html += `<li>${enLinea(lineas[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))}</li>`;
        i += 1;
      }
      html += `</${tag}>`;
      continue;
    }

    // Párrafo. En markdown un salto de línea suelto equivale a un espacio; solo
    // dos espacios al final de la línea (o una barra invertida) fuerzan un <br>.
    const parrafo = [];
    while (
      i < lineas.length &&
      lineas[i].trim() &&
      !/^\s*#{1,6}\s/.test(lineas[i]) &&
      !/^\s*```/.test(lineas[i]) &&
      !esVineta(lineas[i]) &&
      !esNumerada(lineas[i]) &&
      !(lineas[i].includes('|') && i + 1 < lineas.length && esSepTabla(lineas[i + 1]))
    ) {
      parrafo.push(lineas[i]);
      i += 1;
    }
    const CORTE = '@@BR@@';
    const unido = parrafo
      .map((l, k) => {
        const duro = k < parrafo.length - 1 && /(\s{2}|\\)$/.test(l);
        return l.replace(/\\$/, '').trim() + (duro ? CORTE : '');
      })
      .join(' ');
    html += `<p>${enLinea(unido).split(CORTE).join('<br>')}</p>`;
  }

  return html;
}
