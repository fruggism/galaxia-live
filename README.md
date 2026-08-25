# Galaxia Live

Dashboard dell'impero Minecraft **Galaxia**: stato del server, avvisi,
l'atlante e l'archivio generati da [Cube-Atlas](https://github.com/fruggism/FruCraft).

**Sito interamente statico.** Nessun backend: le tre pagine leggono
direttamente il contenuto delle cartelle di `data/` tramite l'API pubblica
di GitHub — **basta trascinarci dentro il file così come lo hai salvato**,
con il suo nome originale. Niente elenchi da editare a mano.

## Struttura

```
index.html          Home — stato server + avvisi
atlante/index.html  Mappa (Lettore di Cube-Atlas, sempre attivo su data/atlante/)
archivio/index.html Documenti (elenco + lettura, da data/archivio/)
data/
  server.json        Indirizzo del server e link utili (unico file, si modifica lui)
  atlante/            Trascinaci l'atlante esportato da Cube-Atlas (un solo file)
  archivio/           Trascinaci i documenti esportati dall'Archivio (uno o più file)
  avvisi/             Un file per ogni avviso da mostrare in home
```

## Aggiornare l'atlante

1. Nell'Editor di Cube-Atlas, **🗺️ Esporta atlante**.
2. Trascina il file scaricato in `data/atlante/` di questo repository,
   con il nome che ha già (es. `MioMondo_ATLAS.json`).
3. Pubblica (push, o upload FTP): la pagina Atlante lo pesca da sola al
   prossimo caricamento — nessun altro passaggio. Se in `data/atlante/`
   c'è più di un file, usa quello con il nome "più alto" in ordine
   alfabetico: in pratica, tienicene uno solo.

Finché `data/atlante/` è vuota, la pagina mostra semplicemente "nessun
atlante ancora".

## Aggiornare l'archivio

1. Nell'Archivio di Cube-Atlas, **📖 Esporta per il Lettore** sul documento
   che vuoi pubblicare.
2. Trascina il file in `data/archivio/`, con il nome che ha già. Puoi
   caricarne più di uno alla volta.

Titolo e autore mostrati nell'elenco vengono letti dal contenuto del file
stesso — non c'è nient'altro da scrivere.

## Aggiornare gli avvisi

Ogni avviso è un file `.json` a sé in `data/avvisi/` (il nome del file non
conta, usalo solo per riconoscerlo tu):

```json
{ "title": "Titolo", "date": "2026-08-25", "body": "Testo dell'avviso.", "pinned": true }
```

`pinned: true` lo mostra in cima; `date` ordina i più recenti per primi.
Per togliere un avviso, elimina il suo file da `data/avvisi/`.

Le tre pagine interrogano `api.github.com` per sapere cosa c'è in ciascuna
cartella: funziona a prescindere da dove ospiti il sito (passim.it, GitHub
Pages, altro), perché parla sempre con GitHub, non con l'hosting. L'unico
limite è quello standard dell'API pubblica di GitHub (60 richieste
all'ora per visitatore anonimo) — ampiamente sufficiente per un sito con
pochi visitatori come questo.

## Collegare il server

Quando il server Minecraft è pronto, modifica `data/server.json`:

```json
{
  "address": "play.galaxia.it",
  "type": "java",
  "note": "Whitelist attiva: scrivi su Discord per essere aggiunto.",
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
`note` è testo libero mostrato sotto lo stato (regole, whitelist, versione
richiesta, quello che vuoi). `links` è altrettanto libero: Discord, una
guida per l'accesso, whitelist, ecc.

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
