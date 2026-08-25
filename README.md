# Galaxia Live

Dashboard dell'impero Minecraft **Galaxia**: stato del server, avvisi,
l'atlante e l'archivio generati da [Cube-Atlas](https://github.com/fruggism/FruCraft).

**Sito interamente statico.** Nessun backend: le pagine leggono file JSON
nella cartella `data/`, aggiornarle vuol dire sostituire quei file e
ripubblicare (o caricarli via FTP, a seconda di come hai collegato il
repository a passim.it).

## Struttura

```
index.html          Home — stato server + avvisi
atlante/index.html  Mappa (Lettore di Cube-Atlas, sempre attivo su data/atlas.json)
archivio/index.html Documenti (elenco + lettura, da data/archivio/)
data/
  server.json        Indirizzo del server e link utili
  avvisi.json         Elenco avvisi mostrati in home
  atlas.json           L'atlante esportato da Cube-Atlas (non versionato finché non esiste)
  archivio/
    index.json         Elenco dei documenti (titolo, autore, nome file)
    *.json             I documenti stessi, esportati dall'Archivio di Cube-Atlas
```

## Aggiornare l'atlante

1. Nell'Editor di Cube-Atlas, **🗺️ Esporta atlante**.
2. Rinomina il file scaricato in `atlas.json` e sostituisci
   `data/atlas.json` in questo repository.
3. Pubblica (push, o upload FTP): la pagina Atlante lo pesca da sola al
   prossimo caricamento — nessun altro passaggio.

Finché `data/atlas.json` non esiste, la pagina mostra semplicemente "nessun
atlante ancora".

## Aggiornare l'archivio

1. Nell'Archivio di Cube-Atlas, **📖 Esporta per il Lettore** sul documento
   che vuoi pubblicare.
2. Salva il file in `data/archivio/` (es. `data/archivio/storia-di-galaxia.json`).
3. Aggiungi una riga in `data/archivio/index.json`:
   ```json
   { "file": "storia-di-galaxia.json", "title": "Storia di Galaxia", "author": "Fru" }
   ```

## Aggiornare gli avvisi

Modifica `data/avvisi.json`, un array di oggetti:

```json
{ "title": "Titolo", "date": "2026-08-25", "body": "Testo dell'avviso.", "pinned": true }
```

`pinned: true` lo mostra in cima; `date` ordina i più recenti per primi.

## Collegare il server

Quando il server Minecraft è pronto, modifica `data/server.json`:

```json
{
  "address": "play.galaxia.it",
  "type": "java",
  "links": [
    { "label": "Discord", "url": "https://discord.gg/..." },
    { "label": "Come accedere", "url": "https://..." }
  ]
}
```

La card "Server" in home chiama da sola l'API pubblica
[mcsrvstat.us](https://api.mcsrvstat.us/) (nessuna chiave, nessun backend) e
mostra online/offline, giocatori connessi, versione e MOTD. Con
`"type": "bedrock"` interroga l'endpoint Bedrock invece di Java.
`links` è libero: mettici Discord, una guida per l'accesso, whitelist, ecc.

## Codice riusato da Cube-Atlas

`js/vendor/` e `css/style.css` + `css/textures.css` sono copiati dal
[repository FruCraft](https://github.com/fruggism/FruCraft) (lo stesso
progetto Cube-Atlas): il rendering dei layer sulla mappa e il tema grafico
Minecraft sono identici a quelli dell'app originale, così un atlante o un
documento esportati si aprono qui senza sorprese.

## Sviluppo locale

```bash
npm run serve   # http://127.0.0.1:5174
```

Solo file statici — nessuna dipendenza da installare.
