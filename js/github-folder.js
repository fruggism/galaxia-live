/*
 * Galaxia Live — legge il contenuto di una cartella di data/ direttamente
 * dall'API pubblica di GitHub, così le pagine mostrano da sole qualunque
 * file ci sia dentro, con il suo nome originale: niente elenco da editare
 * a mano, basta trascinare il file nella cartella giusta del repository.
 */

const OWNER = 'fruggism';
const REPO = 'galaxia-live';
const BRANCH = 'main';

/** Elenca i file .json in una cartella di data/. Una cartella vuota o
 *  inesistente (nessun file ancora caricato) torna semplicemente []. */
export async function listJsonFiles(folder) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${folder}?ref=${BRANCH}`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f.type === 'file' && f.name.toLowerCase().endsWith('.json'));
}

export async function fetchJson(downloadUrl) {
  const res = await fetch(`${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
