#!/usr/bin/env node
/**
 * 3615 IA - une passerelle Minitel vers les grands modeles de langage.
 *
 *   Minitel 1B --DIN--> ESP32 --WiFi/ws--> ce serveur --HTTP--> LLM
 *
 * Voir README.md pour l'installation et la configuration.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { chargerServices } from "./config.mjs";
import { creerBackend } from "./providers.mjs";
import {
  VT, COLS, fg, taille, pos, wrap, decouperFlux, centrer, toVideotex, decoderClavier,
  EmetteurCadence, ROULEAU_ON, ECHO_OFF, CURSEUR_ON, CURSEUR_OFF,
} from "./videotex.mjs";

const PORT      = Number(process.env.PORT ?? 8080);
const HOTE      = process.env.HOST ?? "0.0.0.0";
const BAUDS     = Number(process.env.BAUDS ?? 1200);
const CHEMIN    = process.env.SERVICES ?? null;
const MAX_TOURS = Number(process.env.MAX_TOURS ?? 12);
const MAX_SAISIE = 200;
const JETON     = process.env.CLAVIER_TOKEN ?? null;   // protege le clavier deporte

const ICI = dirname(fileURLToPath(import.meta.url));
const PAGE_CLAVIER = readFileSync(join(ICI, "clavier.html"));

const SYSTEM = `Tu t'affiches sur un Minitel 1B : ecran de 40 colonnes sur 24 \
lignes, liaison a 1200 bauds. Chaque caractere coute du temps d'affichage.

Regles absolues :
- Reponds en francais, en texte brut.
- Aucun markdown : pas de #, *, _, backticks, pas de tableaux, pas de blocs de code.
- Aucun emoji ni caractere exotique. Uniquement l'alphabet latin, les accents \
francais et la ponctuation courante.
- Phrases courtes. 8 lignes de 40 caracteres au maximum, sauf si on te demande \
explicitement du detail.
- Pour une liste, utilise un tiret en debut de ligne.
- Va droit au but, pas de formule d'introduction ni de conclusion.

Tu es un clin d'oeil : la telematique de 1982 qui parle a un modele du \
XXIe siecle. Tu peux etre malicieux la-dessus a l'occasion, sans en faire des \
tonnes.`;

// ---------------------------------------------------------------------------

class Session {
  constructor(ws, ip, services) {
    this.ws = ws;
    this.ip = ip;
    this.services = services;
    this.tx = new EmetteurCadence(ws, BAUDS);
    this.etatClavier = {};
    this.saisie = "";
    this.mode = "menu";          // "menu" | "chat" | "occupe"
    this.service = null;
    this.backend = null;
    this.historique = [];
    this.abandon = null;
  }

  // --- primitives d'affichage ---------------------------------------------

  ecrire(x) { this.tx.envoyer(Buffer.isBuffer(x) ? x : toVideotex(x)); }
  saut(n = 1) { this.tx.envoyer(Buffer.from(Array(n).fill([VT.CR, VT.LF]).flat())); }
  ligne(texte) { this.ecrire(texte); this.saut(); }
  bloc(texte) { for (const l of wrap(texte)) this.ligne(l); }
  bandeau(gauche, droite) {
    const g = String(gauche).slice(0, 20);
    const d = String(droite).slice(0, COLS - 2 - g.length);
    this.tx.envoyer(pos(0, 1));
    this.tx.envoyer(fg("blanc"));
    this.ecrire((" " + g).padEnd(COLS - 1 - d.length) + d);
  }

  // --- menu des services ---------------------------------------------------

  afficherMenu() {
    this.mode = "menu";
    this.saisie = "";
    this.service = null;
    this.backend = null;
    this.historique = [];

    this.tx.purger();
    this.tx.envoyer(Buffer.from([VT.FF]));
    this.tx.envoyer(ROULEAU_ON);
    this.tx.envoyer(ECHO_OFF);
    this.tx.envoyer(CURSEUR_OFF);

    this.bandeau("3615 IA", "");

    // titre en double grandeur : positionnement explicite obligatoire
    this.tx.envoyer(pos(3, 11));
    this.tx.envoyer(fg("cyan"));
    this.tx.envoyer(taille("double"));
    this.ecrire("3615 IA");
    this.tx.envoyer(taille("normale"));

    this.tx.envoyer(pos(5, 1));
    this.tx.envoyer(fg("blanc"));
    this.ligne(centrer("Le Minitel parle aux machines"));
    this.saut();

    this.tx.envoyer(fg("vert"));
    this.services.forEach((s, i) => {
      const num = String(i + 1).padStart(2, " ");
      this.ligne(` ${num} . ${s.nom.padEnd(12)} ${(s.etiquette ?? s.model).slice(0, 18)}`);
    });

    this.saut();
    this.tx.envoyer(fg("jaune"));
    this.ligne(" Numero du service, puis ENVOI");
    this.saut();
    this.invite();
  }

  choisirService(n) {
    const s = this.services[n - 1];
    if (!s) {
      this.tx.envoyer(fg("rouge"));
      this.saut();
      this.ligne(" Service inconnu.");
      this.invite();
      return;
    }
    this.service = s;
    this.backend = creerBackend(s);
    this.historique = [];
    this.mode = "chat";

    this.tx.envoyer(Buffer.from([VT.FF]));
    this.bandeau(`3615 ${s.nom}`, "ENVOI: valider");
    this.tx.envoyer(pos(2, 1));
    this.tx.envoyer(fg("cyan"));
    this.ligne(` Modele : ${s.model}`);
    this.tx.envoyer(fg("vert"));
    this.ligne(" SOMMAIRE : retour au menu");
    this.ligne(" ANNULATION : effacer / interrompre");
    this.saut();
    this.invite();
  }

  invite() {
    this.tx.envoyer(fg("jaune"));
    this.ecrire("> ");
    this.tx.envoyer(CURSEUR_ON);
  }

  // --- clavier -------------------------------------------------------------

  onOctets(buf) {
    for (const ev of decoderClavier(buf, this.etatClavier)) this.onEvenement(ev);
  }

  /** Point d'entree unique : clavier du Minitel comme clavier deporte. */
  onEvenement(ev) {
    if (ev.type === "car") {
      if (this.mode === "occupe" || this.saisie.length >= MAX_SAISIE) return;
      this.saisie += ev.valeur;
      this.ecrire(ev.valeur);              // echo assure par le serveur
      return;
    }
    this.onTouche(ev.valeur);
  }

  /** Injecte une ligne entiere, caractere par caractere, puis valide. */
  injecterLigne(texte) {
    for (const c of String(texte).slice(0, MAX_SAISIE)) {
      this.onEvenement({ type: "car", valeur: c });
    }
    this.onEvenement({ type: "touche", valeur: "ENVOI" });
  }

  onTouche(touche) {
    if (touche === "ANNUL") {
      if (this.mode === "occupe") {        // interrompt la generation en cours
        this.abandon?.abort();
        return;
      }
      this.effacerSaisie();
      return;
    }
    if (this.mode === "occupe") return;

    switch (touche) {
      case "CORRECTION":
        if (this.saisie) {
          this.saisie = this.saisie.slice(0, -1);
          this.tx.envoyer(Buffer.from([VT.BS, 0x20, VT.BS]));
        }
        break;
      case "SOMMAIRE":
        this.afficherMenu();
        break;
      case "GUIDE":
        this.afficherAide();
        break;
      case "ENVOI": {
        const texte = this.saisie.trim();
        this.saisie = "";
        if (!texte) { this.saut(); this.invite(); break; }
        if (this.mode === "menu") this.choisirService(Number(texte));
        else this.interroger(texte);
        break;
      }
    }
  }

  effacerSaisie() {
    this.tx.envoyer(Buffer.from(Array(this.saisie.length).fill([VT.BS, 0x20, VT.BS]).flat()));
    this.saisie = "";
  }

  afficherAide() {
    this.saut(2);
    this.tx.envoyer(fg("cyan"));
    this.ligne(" ENVOI ...... valider la saisie");
    this.ligne(" CORRECTION . effacer un caractere");
    this.ligne(" ANNULATION . effacer / interrompre");
    this.ligne(" SOMMAIRE ... retour au menu");
    this.saut();
    this.invite();
  }

  // --- interrogation du modele ---------------------------------------------

  async interroger(question) {
    this.mode = "occupe";
    this.tx.envoyer(CURSEUR_OFF);
    this.saut(2);
    this.tx.envoyer(fg("blanc"));

    this.historique.push({ role: "user", content: question });
    if (this.historique.length > MAX_TOURS) this.historique = this.historique.slice(-MAX_TOURS);

    this.abandon = new AbortController();
    let reponse = "";
    let reste = "";                        // fragment de ligne pas encore emis

    try {
      const flux = this.backend.stream(this.historique, SYSTEM, this.abandon.signal);
      // Emission ligne par ligne : sur 40 colonnes, on ne sait ou couper
      // qu'une fois le mot complet recu.
      for await (const delta of flux) {
        reponse += delta;
        const decoupe = decouperFlux(reste + delta);
        for (const l of decoupe.lignes) this.ligne(l);
        reste = decoupe.reste;
      }
      if (reste) this.ecrire(reste);
      if (reponse.trim()) this.historique.push({ role: "assistant", content: reponse });
      else this.historique.pop();
    } catch (err) {
      const interrompu = err?.name === "AbortError";
      if (interrompu) {
        this.tx.purger();
        this.tx.envoyer(fg("rouge"));
        this.saut();
        this.ligne(" [interrompu]");
      } else {
        console.error(`[${this.ip}] ${this.service?.nom} :`, err);
        this.tx.envoyer(fg("rouge"));
        this.saut();
        this.ligne(" *** DEFAUT DE SERVICE ***");
        this.bloc(err?.message ?? String(err));
      }
      this.historique.pop();
    } finally {
      this.abandon = null;
    }

    this.saut(2);
    this.mode = "chat";
    this.invite();
  }

  fermer() { this.abandon?.abort(); this.tx.arreter(); }
}

// ---------------------------------------------------------------------------

const { fichier, services, ecartes } = await chargerServices(CHEMIN);

console.log(`3615 IA`);
console.log(`  configuration : ${fichier}`);
for (const s of services) console.log(`  service       : ${s.nom} (${s.kind}) ${s.model}`);
for (const e of ecartes) console.log(`  ecarte        : ${e}`);

if (!services.length) {
  console.error("\nAucun service utilisable. Renseignez au moins une cle d'API,");
  console.error("ou declarez un serveur local dans services.json.");
  process.exit(1);
}

// Registre des sessions Minitel, pour que le clavier deporte sache a qui parler.
const sessions = new Set();
const claviers = new Set();

function minitelCourant() {
  return [...sessions].at(-1) ?? null;   // la session la plus recemment ouverte
}
function prevenirClaviers() {
  const dispo = minitelCourant() !== null;
  for (const c of claviers) {
    if (c.readyState === c.OPEN) c.send(JSON.stringify({ type: "etat", minitel: dispo }));
  }
}

// --- serveur HTTP : sert la page du clavier deporte ------------------------

const httpServer = http.createServer((req, res) => {
  const chemin = new URL(req.url, "http://x").pathname;
  if (chemin === "/clavier" || chemin === "/clavier/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE_CLAVIER);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("3615 IA\n\nMinitel  : ws://<hote>:" + PORT + "/\nClavier  : http://<hote>:" + PORT + "/clavier\n");
});

// --- deux WebSockets sur le meme port, distinguees par le chemin ------------

const wsMinitel = new WebSocketServer({ noServer: true });
const wsClavier = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, tete) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/clavier") {
    if (JETON && url.searchParams.get("jeton") !== JETON) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wsClavier.handleUpgrade(req, socket, tete, (ws) => wsClavier.emit("connection", ws, req));
  } else {
    wsMinitel.handleUpgrade(req, socket, tete, (ws) => wsMinitel.emit("connection", ws, req));
  }
});

// --- Minitel ---------------------------------------------------------------

wsMinitel.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[${ip}] Minitel connecte`);
  const session = new Session(ws, ip, services);
  sessions.add(session);
  prevenirClaviers();

  // un seul service utilisable : on saute le menu
  if (services.length === 1) {
    session.tx.envoyer(Buffer.from([VT.FF]));
    session.tx.envoyer(ROULEAU_ON);
    session.tx.envoyer(ECHO_OFF);
    session.choisirService(1);
  } else {
    session.afficherMenu();
  }

  ws.on("message", (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    session.onOctets(isBinary ? buf : Buffer.from(buf.toString("latin1"), "latin1"));
  });
  const fin = () => { sessions.delete(session); session.fermer(); prevenirClaviers(); };
  ws.on("close", () => { console.log(`[${ip}] Minitel deconnecte`); fin(); });
  ws.on("error", (e) => { console.error(`[${ip}]`, e.message); fin(); });
});

// --- clavier deporte -------------------------------------------------------
// Le clavier du Minitel n'est pas toujours en etat : quarante ans de caoutchouc
// conducteur, ca s'oxyde. Cette seconde WebSocket injecte la saisie dans la
// session comme si elle venait du port DIN, sans toucher au firmware ESP32.

wsClavier.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[${ip}] clavier deporte connecte`);
  claviers.add(ws);
  ws.send(JSON.stringify({ type: "etat", minitel: minitelCourant() !== null }));

  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(data.toString("utf8")); } catch { return; }
    const session = minitelCourant();
    if (!session) {
      ws.send(JSON.stringify({ type: "info", texte: "aucun Minitel connecte" }));
      return;
    }
    if (m.type === "ligne" && typeof m.texte === "string") session.injecterLigne(m.texte);
    else if (m.type === "touche" && typeof m.valeur === "string") {
      session.onEvenement({ type: "touche", valeur: m.valeur });
    }
  });

  ws.on("close", () => { claviers.delete(ws); console.log(`[${ip}] clavier deporte deconnecte`); });
  ws.on("error", () => claviers.delete(ws));
});

httpServer.listen(PORT, HOTE, () => {
  console.log(`\n  Minitel       : ws://${HOTE}:${PORT}/`);
  console.log(`  clavier       : http://${HOTE}:${PORT}/clavier${JETON ? "?jeton=" + JETON : ""}`);
  console.log(`  debit         : ${BAUDS} bauds`);
});
