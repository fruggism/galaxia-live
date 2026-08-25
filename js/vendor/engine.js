/*
 * Page-side client for the map worker: promise-based requests, plus progress
 * callbacks for the long-running render job.
 */

const WORKER_URL = new URL('../worker.js', import.meta.url);

class Engine {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.progressHandlers = new Map();
  }

  start() {
    if (this.worker) return;
    this.worker = new Worker(WORKER_URL, { type: 'module' });
    this.worker.onmessage = (event) => {
      const { id, result, error, type, requestId, progress } = event.data || {};
      if (type === 'progress') {
        const cb = this.progressHandlers.get(requestId);
        if (cb) cb(progress);
        return;
      }
      if (type === 'ready') return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      this.progressHandlers.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    };
    this.worker.onerror = (e) => {
      const message = e.message || 'Errore nel motore della mappa';
      for (const [, entry] of this.pending) entry.reject(new Error(message));
      this.pending.clear();
    };
  }

  request(type, payload, onProgress) {
    this.start();
    const id = this.nextId++;
    if (onProgress) this.progressHandlers.set(id, onProgress);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload: payload || {} });
    });
  }

  openWorld(init) { return this.request('openWorld', { init }); }
  setRenderSettings(settings) { return this.request('setRenderSettings', { settings }); }
  tile(dimId, z, x, y, kind) { return this.request('tile', { dimId, z, x, y, kind }); }
  probe(dimId, x, z) { return this.request('probe', { dimId, x, z }); }
  renderStatus(dimId) { return this.request('renderStatus', { dimId }); }
  render(dimId, area, withRails, onProgress) {
    return this.request('render', { dimId, area, withRails }, onProgress);
  }
  cancelRender() { return this.request('cancelRender', {}); }
  clearCache(dimId) { return this.request('clearCache', { dimId }); }
  cacheStats(dimId) { return this.request('cacheStats', { dimId }); }
}

export const engine = new Engine();
