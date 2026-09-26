# Portata

Web app per restare in chiamata con i contatti che si trovano entro 1 km da te.
Chi si allontana esce dalla chiamata, chi si avvicina entra. Le persone si ritrovano con un
**codice stanza** (per esempio `AMICI42`): solo chi usa lo stesso codice può sentirti.

## Come funziona

- Il telefono legge la posizione dal GPS e la manda al server ogni pochi secondi, quando ti muovi.
- Il server calcola le distanze tra le persone della stanza. Quando due persone sono più vicine
  del raggio (1 km, o meno se lo abbassi), dice ai due telefoni di collegarsi.
- L'audio passa **direttamente da telefono a telefono** (WebRTC). Il server fa solo da centralino,
  quindi non serve un servizio audio a pagamento. Regge bene fino a 5–6 persone in chiamata insieme.
- Per non entrare e uscire di continuo sul confine, si esce solo oltre il raggio + 10%.
- **Mappa:** chi è nella stessa stanza ti vede sulla mappa (OpenStreetMap), insieme al cerchio
  da 1 km. Le posizioni non vengono salvate da nessuna parte e non arrivano a chi non ha il codice.
  Con "Invisibile" (nelle impostazioni) sparisci dalla mappa e dalle chiamate.

## I comandi

- **Microfono:** tocca per spegnerlo o riaccenderlo.
- **Premi per parlare** (impostazioni): il microfono diventa "Tieni premuto"; gli altri ti sentono
  solo mentre lo tieni schiacciato.
- **Microfono spento = microfono libero:** quando il microfono è spento (muto, premi per parlare a
  riposo, modalità musica) Portata lo restituisce al telefono, così la musica può suonare.
- **Musica:** metti in pausa il tuo microfono e restituisce l'audio al telefono, così puoi far
  partire Spotify o Apple Music e continuare a sentire gli altri sopra la musica. Per parlare tocchi
  (o tieni premuto) il microfono: iPhone ferma la musica mentre parli. Quando lasci, il microfono si
  libera; se la musica non riparte da sola, premi play dal Centro di Controllo. Se fai partire la
  musica mentre sei in chiamata, Portata se ne accorge e passa da sola alla modalità musica.
  Mescolare musica e voci richiede iOS 17 o successivo; va provato sul proprio telefono.
- **Meta:** cerca un indirizzo, un locale o un posto, oppure tocca un punto sulla mappa o usa la tua
  posizione; dagli un nome e condividilo. Tutti nella stanza la vedono, con la distanza di ognuno.
  Chiunque può cambiarla o toglierla. La ricerca interroga insieme più fonti gratuite, senza chiavi:
  Photon e Overpass (OpenStreetMap), Esri World Geocoder (molto completo su bar, negozi e locali) e,
  se trovano poco, Nominatim. I risultati vengono uniti, i doppioni tolti, e prima compaiono quelli
  che corrispondono meglio e sono più vicini, con il tipo di posto. Se il server non risponde, il
  telefono chiede direttamente a Photon.
- **Vai:** apre le indicazioni stradali in auto verso la meta. La prima volta scegli l'app (Apple
  Mappe, Google Maps, Waze); con "Ricorda la scelta" le volte dopo si apre direttamente. Si cambia
  in Impostazioni → App per le indicazioni. Su iPhone Mappe e Google Maps si aprono con il loro
  collegamento diretto (maps:// e comgooglemaps://).
- **Tasti del volante e delle cuffie** (impostazioni, attivo di serie): il tasto play/pausa del
  volante (via Bluetooth), delle cuffie o degli AirPods accende e spegne il microfono. Sullo schermo
  dell'auto compare lo stato ("Microfono acceso · In chiamata con Giulia"). Funziona quando l'audio
  in riproduzione è Portata: se sta suonando Spotify, il tasto va a Spotify. Il tasto
  "rispondi/riaggancia" e CarPlay non sono raggiungibili da una web app.
- **Stile della mappa** (icona a strati in alto): Standard (chiara e pulita, simile a Google Maps),
  Scura, Satellite. La mappa è vettoriale (MapLibre) con gli stili gratuiti di OpenFreeMap, senza
  chiave; il satellite usa le immagini Esri, gratuite per un uso personale. I pannelli in vetro
  diventano chiari sulla mappa Standard e scuri sulle altre, per restare leggibili.
- **Persone** (in alto a sinistra): toccane una per centrare la mappa su di lei. Con il tasto
  altoparlante accanto a chi è in chiamata la silenzi solo per te (lei continua a sentirti);
  la scelta si ricorda. Tutti gli altri si sentono sempre a volume pieno.
- **Tasto con la freccia** (sopra la barra dei comandi): il primo tocco ti centra da vicino, il
  secondo mostra tutto il cerchio da 1 km.
- **Mini** (impostazioni): apre la mini finestra (Picture in Picture) con chi è in chiamata.

## File

| File | Cosa fa |
|---|---|
| `server.js` | Server Node: pagine, stanze, distanze, collegamenti WebRTC |
| `index.html`, `style.css` | Interfaccia |
| `app.js` | Posizione, microfono, chiamata, mini finestra, diagnostica |
| `render.yaml` | Configurazione per pubblicarla su Render |

In questa versione tutti i file stanno nella stessa cartella, così si possono caricare su GitHub
anche dal telefono.

## Provarla

Microfono e posizione funzionano solo su pagine **https://**. Hai due strade.

### A. Prova veloce dal tuo computer (10 minuti)

Serve [Node.js](https://nodejs.org) 18 o più recente.

```bash
cd portata
npm install
npm start          # parte su http://localhost:3000
```

Sul computer puoi già aprire `http://localhost:3000`. Per i telefoni serve un indirizzo https:
il modo più semplice è un tunnel di Cloudflare, gratuito e senza account.

```bash
# Mac: brew install cloudflared    Windows: winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

Stampa un indirizzo tipo `https://qualcosa.trycloudflare.com`: aprilo sui telefoni.
Funziona finché il computer e il comando restano accesi.

### B. Online sempre raggiungibile (Render, gratis)

1. Carica la cartella `portata` in un nuovo repository su GitHub.
2. Su [render.com](https://render.com) scegli **New → Blueprint** e seleziona il repository:
   legge `render.yaml` e configura tutto da solo.
3. Dopo qualche minuto hai un indirizzo `https://portata-xxxx.onrender.com`.

Nel piano gratuito il server si addormenta dopo 15 minuti senza nessuno collegato: il primo
accesso dopo una pausa impiega circa 30 secondi.

### Metterla sulla schermata Home

- **iPhone:** in Safari, pulsante Condividi → *Aggiungi alla schermata Home*.
- **Android:** in Chrome, menu ⋮ → *Aggiungi a schermata Home* (o *Installa app*).

## Provare la mini finestra (PiP) e il secondo piano

La web app funziona bene con la pagina aperta. Il punto da verificare è cosa succede quando
cambi app. La sezione **Diagnostica secondo piano** serve proprio a questo.

1. Entrate in due nella stessa stanza, vicini, e controllate di sentirvi.
2. Sul telefono da provare tocca **Mini**.
3. Passa a un'altra app per almeno 30 secondi, e intanto l'altra persona parla.
4. Torna in Portata. In Diagnostica trovi una riga come:
   *Fuori per 45 s · mini finestra aperta — Posizione aggiornata 6 volte, Microfono sempre attivo,
   Collegamento al server mantenuto.*
5. Ripeti senza mini finestra e con **Schermo sempre acceso** (impostazioni), per confrontare.

Cosa aspettarsi, da verificare sul tuo telefono:

- **Android (Chrome):** di solito la chiamata continua in secondo piano. La posizione può
  rallentare o fermarsi.
- **iPhone (Safari):** Safari tende a silenziare il microfono quando la pagina va in secondo piano,
  anche con la mini finestra aperta. Se la diagnostica dice "Microfono interrotto dal sistema",
  su iPhone serve l'app nativa per usarla con il telefono in tasca.
- **Schermo sempre acceso** è il piano B più affidabile: la pagina resta in primo piano,
  a costo di più batteria.

## Se due persone vicine non si collegano

Se resta su "Collegamento…" o compare "Collegamento non riuscito", di solito è la rete mobile
(4G/5G) che blocca i collegamenti diretti tra telefoni. Serve un server TURN che faccia da ponte,
per esempio il piano gratuito di [Metered](https://www.metered.ca/stun-turn).

Modo semplice, con Metered: su Render apri il servizio → *Environment* e aggiungi due variabili
con utente e password che trovi nella dashboard di Metered:

- `TURN_USERNAME` = il nome utente
- `TURN_CREDENTIAL` = la password

Con un altro servizio TURN aggiungi anche `TURN_URLS` (indirizzi separati da virgola), oppure
scrivi tutto in `ICE_SERVERS` come JSON:

```json
[{"urls":"stun:stun.l.google.com:19302"},
 {"urls":"turn:INDIRIZZO:80","username":"UTENTE","credential":"PASSWORD"}]
```

## Limiti noti

- Massimo 12 persone per stanza. Oltre le 5–6 persone nella stessa chiamata i collegamenti diretti
  pesano sulla batteria e sulla rete: per gruppi grandi conviene un server audio come LiveKit.
- Le stanze vivono in memoria: se il server si riavvia, i telefoni si ricollegano da soli.
