/*
 * Galaxia Live — Archivio: ogni documento esportato da Cube-Atlas, letto
 * direttamente da data/archivio/ — basta trascinarli lì, con il nome che
 * hanno già: titolo e autore vengono dal contenuto del file stesso.
 */

import { el, escapeHtml, setStatus } from './vendor/ui-core.js';
import { listJsonFiles, fetchJson } from './github-folder.js';

const READER_DOC_FORMAT = 'cube-atlas/document';
const DOCS_FOLDER = 'data/archivio';

let docs = []; // [{ name, title, author, pages }]

function renderList() {
  const host = el('doc-list');
  if (!docs.length) {
    host.innerHTML = '<li class="hint">Nessun documento ancora. Esportane uno dall\'Archivio di Cube-Atlas ' +
      '("📖 Esporta per il Lettore") e trascinalo in data/archivio/ di questo repository.</li>';
    return;
  }
  host.innerHTML = docs.map((d, i) => `
    <li class="doc-item" data-index="${i}">
      <b>${escapeHtml(d.title || d.name)}</b>
      ${d.author ? `<small>di ${escapeHtml(d.author)}</small>` : ''}
    </li>`).join('');
  host.querySelectorAll('.doc-item').forEach((node) => {
    node.addEventListener('click', () => {
      host.querySelectorAll('.doc-item').forEach((n) => n.classList.remove('selected'));
      node.classList.add('selected');
      showDoc(docs[Number(node.dataset.index)]);
    });
  });
}

function showDoc(doc) {
  const pages = doc.pages && doc.pages.length ? doc.pages : [''];
  el('doc-title').textContent = doc.title || 'Senza titolo';
  el('doc-author').textContent = doc.author ? `di ${doc.author}` : '';
  el('doc-pages').innerHTML = pages.map((p, i) => (
    `<div class="book-page">${escapeHtml(p) || '<i>(pagina vuota)</i>'}<span class="page-no">${i + 1}/${pages.length}</span></div>`
  )).join('');
  el('doc-empty').classList.add('hidden');
  el('doc-view').classList.remove('hidden');
  setStatus('doc-status', `"${doc.title || doc.name}" aperto`, 'ok');
}

async function load() {
  try {
    const files = await listJsonFiles(DOCS_FOLDER);
    const results = await Promise.all(files.map(async (f) => {
      try {
        const raw = await fetchJson(f.download_url);
        if (raw && raw.format && raw.format !== READER_DOC_FORMAT) return null;
        return {
          name: f.name,
          title: typeof raw.title === 'string' ? raw.title : f.name,
          author: typeof raw.author === 'string' ? raw.author : '',
          pages: Array.isArray(raw.pages) ? raw.pages : null,
        };
      } catch {
        return null; // un file non valido non deve rompere l'elenco degli altri
      }
    }));
    docs = results.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title, 'it'));
  } catch (err) {
    setStatus('doc-status', `Elenco non disponibile: ${err.message}`, 'err');
    docs = [];
  }
  renderList();
}

document.addEventListener('DOMContentLoaded', load);
