/*
 * Galaxia Live — home: stato del server, avvisi.
 *
 * Lo stato del server non richiede nessun backend: mcsrvstat.us fa il ping
 * al server Minecraft e risponde via un'API pubblica con CORS abilitato.
 * Finché data/server.json non ha un indirizzo, la card resta un placeholder.
 * Gli avvisi vengono letti da data/avvisi/: un file per avviso, con il nome
 * che ha già — niente elenco da tenere aggiornato a mano.
 */

import { listJsonFiles, fetchJson } from './github-folder.js';

const el = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

async function loadServerInfo() {
  let cfg = {};
  try {
    const res = await fetch(`data/server.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) cfg = await res.json();
  } catch { /* niente configurazione ancora: si resta sul placeholder */ }

  renderLinks(cfg);

  if (!cfg.address) {
    renderServerCard({ configured: false });
    return;
  }
  const base = { configured: true, address: cfg.address, note: cfg.note || '' };
  renderServerCard({ ...base, loading: true });
  try {
    const kind = cfg.type === 'bedrock' ? 'bedrock' : 'java';
    const res = await fetch(`https://api.mcsrvstat.us/3/${kind === 'bedrock' ? 'bedrock/' : ''}${encodeURIComponent(cfg.address)}`);
    const data = await res.json();
    renderServerCard({ ...base, ...data });
  } catch (err) {
    renderServerCard({ ...base, error: err.message });
  }
}

function renderServerCard(s) {
  const host = el('server-card');
  if (!s.configured) {
    host.innerHTML = `
      <div class="server-status unknown">
        <span class="dot"></span>
        <span>Server non ancora configurato</span>
      </div>
      <p class="hint">Quando il server sarà pronto, metti il suo indirizzo in
        <code>data/server.json</code>: da qui in poi questa card mostrerà da sola
        online/offline, giocatori connessi e versione.</p>`;
    return;
  }
  const noteHtml = s.note ? `<p class="server-note">${escapeHtml(s.note)}</p>` : '';
  if (s.loading) {
    host.innerHTML = `<div class="server-status unknown"><span class="dot"></span><span>Controllo in corso…</span></div>${noteHtml}`;
    return;
  }
  if (s.error || s.online === undefined) {
    host.innerHTML = `
      <div class="server-status unknown">
        <span class="dot"></span>
        <span>Stato non disponibile${s.error ? ` (${escapeHtml(s.error)})` : ''}</span>
      </div>
      <p class="hint">Indirizzo: <code>${escapeHtml(s.address)}</code></p>${noteHtml}`;
    return;
  }
  const players = s.players || {};
  host.innerHTML = `
    <div class="server-status ${s.online ? 'online' : 'offline'}">
      <span class="dot"></span>
      <span>${s.online ? 'Online' : 'Offline'}</span>
    </div>
    <div class="server-address" data-copy="${escapeHtml(s.address)}" title="Clicca per copiare">
      <code>${escapeHtml(s.address)}</code> <span class="copy-ico">⧉</span>
    </div>
    ${s.online ? `
      <div class="server-meta">
        <span>👥 ${players.online ?? 0}/${players.max ?? '?'}</span>
        ${s.version ? `<span>🧱 ${escapeHtml(s.version)}</span>` : ''}
      </div>
      ${s.motd && s.motd.clean ? `<p class="motd">${escapeHtml(s.motd.clean.join(' '))}</p>` : ''}
      ${players.list && players.list.length ? `
        <div class="player-list">${players.list.map((p) => `<span class="player-chip">${escapeHtml(p.name || p)}</span>`).join('')}</div>
      ` : ''}
    ` : `<p class="hint">Il server non risponde in questo momento.</p>`}
    ${noteHtml}`;

  const addrNode = host.querySelector('.server-address');
  if (addrNode) {
    addrNode.addEventListener('click', () => {
      navigator.clipboard?.writeText(addrNode.dataset.copy).then(() => {
        addrNode.querySelector('.copy-ico').textContent = '✔';
        setTimeout(() => { addrNode.querySelector('.copy-ico').textContent = '⧉'; }, 1200);
      });
    });
  }
}

function renderLinks(cfg) {
  const host = el('server-links');
  const links = Array.isArray(cfg.links) ? cfg.links : [];
  if (!links.length) { host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  host.innerHTML = links.map((l) => (
    `<a class="btn btn-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label || l.url)}</a>`
  )).join('');
}

async function loadAvvisi() {
  const host = el('avvisi-list');
  let avvisi = [];
  try {
    const files = await listJsonFiles('data/avvisi');
    const results = await Promise.all(files.map(async (f) => {
      try {
        const raw = await fetchJson(f.download_url);
        return {
          title: typeof raw.title === 'string' ? raw.title : f.name,
          date: typeof raw.date === 'string' ? raw.date : '',
          body: typeof raw.body === 'string' ? raw.body : '',
          pinned: raw.pinned === true,
        };
      } catch {
        return null; // un file scritto male non deve far sparire gli altri
      }
    }));
    avvisi = results.filter(Boolean);
  } catch { avvisi = []; }

  if (!avvisi.length) {
    host.innerHTML = '<li class="hint">Nessun avviso al momento.</li>';
    return;
  }
  host.innerHTML = '';
  avvisi
    .slice()
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || new Date(b.date || 0) - new Date(a.date || 0))
    .forEach((a) => {
      const li = document.createElement('li');
      li.className = `avviso ${a.pinned ? 'pinned' : ''}`;
      const when = a.date ? new Date(a.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
      li.innerHTML = `
        <div class="avviso-head">
          ${a.pinned ? '<span class="pin">📌</span>' : ''}
          <b>${escapeHtml(a.title || 'Avviso')}</b>
          ${when ? `<small>${escapeHtml(when)}</small>` : ''}
        </div>
        <p>${escapeHtml(a.body || '')}</p>`;
      host.appendChild(li);
    });
}

document.addEventListener('DOMContentLoaded', () => {
  loadServerInfo();
  loadAvvisi();
});
