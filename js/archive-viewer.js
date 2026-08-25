/*
 * Galaxia Live — Archivio: elenco dei documenti esportati da Cube-Atlas.
 *
 * Legge data/archivio/index.json (un elenco {file, title, author}) e, alla
 * scelta di un documento, il file stesso — stesso formato "cube-atlas/document"
 * che l'Archivio dell'Editor scrive con "📖 Esporta per il Lettore".
 */

import { el, escapeHtml, setStatus } from './vendor/ui-core.js';

const READER_DOC_FORMAT = 'cube-atlas/document';
const INDEX_URL = '../data/archivio/index.json';

let manifest = [];

function renderList() {
  const host = el('doc-list');
  if (!manifest.length) {
    host.innerHTML = '<li class="hint">Nessun documento ancora. Esportane uno dall\'Archivio di Cube-Atlas ' +
      'e aggiungilo a data/archivio/, elencandolo in data/archivio/index.json.</li>';
    return;
  }
  host.innerHTML = manifest.map((d, i) => `
    <li class="doc-item" data-index="${i}">
      <b>${escapeHtml(d.title || d.file)}</b>
      ${d.author ? `<small>di ${escapeHtml(d.author)}</small>` : ''}
    </li>`).join('');
  host.querySelectorAll('.doc-item').forEach((node) => {
    node.addEventListener('click', () => {
      host.querySelectorAll('.doc-item').forEach((n) => n.classList.remove('selected'));
      node.classList.add('selected');
      openDoc(manifest[Number(node.dataset.index)]);
    });
  });
}

function renderDocument(doc) {
  const pages = doc.pages && doc.pages.length ? doc.pages : [''];
  el('doc-title').textContent = doc.title || 'Senza titolo';
  el('doc-author').textContent = doc.author ? `di ${doc.author}` : '';
  el('doc-pages').innerHTML = pages.map((p, i) => (
    `<div class="book-page">${escapeHtml(p) || '<i>(pagina vuota)</i>'}<span class="page-no">${i + 1}/${pages.length}</span></div>`
  )).join('');
  el('doc-empty').classList.add('hidden');
  el('doc-view').classList.remove('hidden');
}

function parsePlainTxt(text, filename) {
  const lines = text.split(/\r\n?|\n/);
  let i = 0;
  const title = lines[i] || filename;
  i++;
  let author = '';
  if (lines[i] && lines[i].startsWith('di ')) { author = lines[i].slice(3); i++; }
  while (lines[i] === '') i++;
  return { title, author, pages: [lines.slice(i).join('\n')] };
}

async function openDoc(entry) {
  try {
    const res = await fetch(`../data/archivio/${entry.file}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const looksJson = entry.file.toLowerCase().endsWith('.json');
    if (looksJson) {
      const raw = JSON.parse(text);
      if (raw && raw.format && raw.format !== READER_DOC_FORMAT) {
        throw new Error('Questo file non è un documento Cube-Atlas');
      }
      renderDocument({
        title: typeof raw.title === 'string' ? raw.title : entry.file,
        author: typeof raw.author === 'string' ? raw.author : '',
        pages: Array.isArray(raw.pages) ? raw.pages : null,
      });
    } else {
      renderDocument(parsePlainTxt(text, entry.file));
    }
    setStatus('doc-status', `"${entry.title || entry.file}" aperto`, 'ok');
  } catch (err) {
    setStatus('doc-status', `Apertura fallita: ${err.message}`, 'err');
  }
}

async function load() {
  try {
    const res = await fetch(`${INDEX_URL}?t=${Date.now()}`, { cache: 'no-store' });
    manifest = res.ok ? await res.json() : [];
    if (!Array.isArray(manifest)) manifest = [];
  } catch {
    manifest = [];
  }
  renderList();
}

document.addEventListener('DOMContentLoaded', load);
