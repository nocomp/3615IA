/**
 * Codage et decodage Videotel / Videotex (norme STUM1B).
 * Le Minitel n'est pas en UTF-8 : les accents s'ecrivent SS2 + accent + lettre.
 */

export const COLS = 40;
export const LIGNES = 24;

export const VT = {
  FF:  0x0c,   // effacement ecran + retour en haut
  BS:  0x08,   // curseur gauche
  LF:  0x0a,
  CR:  0x0d,
  SS2: 0x19,   // prefixe jeu G2 (accents, symboles)
  ESC: 0x1b,
  US:  0x1f,   // positionnement : US + (0x40+ligne) + (0x40+colonne)
  SEP: 0x13,   // prefixe touche de fonction
};

const FG = { noir:0x40, rouge:0x41, vert:0x42, jaune:0x43, bleu:0x44, magenta:0x45, cyan:0x46, blanc:0x47 };
const BG = { noir:0x50, rouge:0x51, vert:0x52, jaune:0x53, bleu:0x54, magenta:0x55, cyan:0x56, blanc:0x57 };

// Attributs de taille. Un caractere agrandi deborde sur la ligne du dessus :
// a n'utiliser qu'avec un positionnement explicite, jamais en mode rouleau.
const TAILLE = { normale:0x4c, hauteur:0x4d, largeur:0x4e, double:0x4f };

export const fg     = (n) => Buffer.from([VT.ESC, FG[n]]);
export const bg     = (n) => Buffer.from([VT.ESC, BG[n]]);
export const taille = (n) => Buffer.from([VT.ESC, TAILLE[n]]);
export const pos    = (lig, col) => Buffer.from([VT.US, 0x40 + lig, 0x40 + col]);

// PRO2 : mode rouleau (defilement vertical)
export const ROULEAU_ON  = Buffer.from([VT.ESC, 0x3a, 0x69, 0x43]);
export const ROULEAU_OFF = Buffer.from([VT.ESC, 0x3a, 0x6a, 0x43]);
// PRO3 : coupure de l'aiguillage clavier -> ecran (echo local desactive).
// Si chaque caractere s'affiche en double, essayer ECHO_OFF_ALT.
export const ECHO_OFF     = Buffer.from([VT.ESC, 0x3b, 0x62, 0x50, 0x51]);
export const ECHO_OFF_ALT = Buffer.from([VT.ESC, 0x3b, 0x6a, 0x50, 0x51]);
export const CURSEUR_ON   = Buffer.from([0x11]);
export const CURSEUR_OFF  = Buffer.from([0x14]);

// Touches de fonction, precedees de SEP (0x13)
export const TOUCHE = {
  0x41: "ENVOI",  0x42: "RETOUR",   0x43: "REPETITION", 0x44: "GUIDE",
  0x45: "ANNUL",  0x46: "SOMMAIRE", 0x47: "CORRECTION", 0x48: "SUITE",
};

// --- Jeu G2 ---------------------------------------------------------------

// Diacritiques combinants issus de la normalisation NFD
const DIACRITIQUES = {
  "\u0300": 0x41, // grave
  "\u0301": 0x42, // aigu
  "\u0302": 0x43, // circonflexe
  "\u0308": 0x48, // trema
  "\u030a": 0x4a, // rond en chef
  "\u0327": 0x4b, // cedille
};
const DIACRITIQUE_PAR_CODE = Object.fromEntries(
  Object.entries(DIACRITIQUES).map(([c, v]) => [v, c]),
);

// Caracteres isoles du jeu G2
const G2 = {
  "£":0x23, "$":0x24, "#":0x26, "§":0x27, "°":0x30, "±":0x31,
  "←":0x2c, "↑":0x2d, "→":0x2e, "↓":0x2f,
  "¼":0x3c, "½":0x3d, "¾":0x3e, "÷":0x38,
  "œ":0x7a, "Œ":0x6a, "ß":0x7b, "¶":0x7c,
};
const G2_PAR_CODE = Object.fromEntries(Object.entries(G2).map(([c, v]) => [v, c]));

// Caracteres absents du Videotex -> equivalent ASCII
const REMPLACEMENTS = {
  "’":"'", "‘":"'", "“":'"', "”":'"', "«":'"', "»":'"',
  "–":"-", "—":"-", "―":"-", "…":"...", "•":"-", "·":"-",
  "€":"EUR", "\u00a0":" ", "\u202f":" ", "\t":"  ",
};

/** Convertit une chaine UTF-8 en octets Videotex. */
export function toVideotex(str) {
  const out = [];
  let s = "";
  for (const ch of String(str)) s += REMPLACEMENTS[ch] ?? ch;

  for (const ch of s.normalize("NFD")) {
    const cp = ch.codePointAt(0);

    if (DIACRITIQUES[ch] !== undefined) {
      // la marque combinante se place AVANT la lettre deja emise
      const lettre = out.pop();
      if (lettre === undefined) continue;
      out.push(VT.SS2, DIACRITIQUES[ch], lettre);
      continue;
    }
    if (G2[ch] !== undefined) { out.push(VT.SS2, G2[ch]); continue; }
    if (cp === 0x0a) { out.push(VT.CR, VT.LF); continue; }
    if (cp >= 0x20 && cp <= 0x7e) { out.push(cp); continue; }
    // emoji, CJK, symboles exotiques : ignores
  }
  return Buffer.from(out);
}

/** Decoupe un texte en lignes de <= largeur caracteres, sans couper les mots. */
export function wrap(texte, largeur = COLS) {
  const lignes = [];
  for (const paragraphe of String(texte).split("\n")) {
    if (paragraphe === "") { lignes.push(""); continue; }
    let courante = "";
    for (const mot of paragraphe.split(/\s+/)) {
      if (mot === "") continue;
      if (courante === "") courante = mot;
      else if ((courante + " " + mot).length <= largeur) courante += " " + mot;
      else { lignes.push(courante); courante = mot; }
      while (courante.length > largeur) {
        lignes.push(courante.slice(0, largeur));
        courante = courante.slice(largeur);
      }
    }
    if (courante) lignes.push(courante);
  }
  return lignes;
}

/**
 * Decoupage incrementiel pour un flux de tokens.
 *
 * Rend les lignes desormais completes et la queue non encore emise, celle-ci
 * conservee telle quelle, espaces finaux compris : un fragment se terminant par
 * une espace doit pouvoir se recoller au fragment suivant. C'est pour cette
 * raison qu'on ne peut pas simplement rappeler wrap() sur le texte accumule,
 * qui normalise les blancs et souderait les mots entre eux.
 */
export function decouperFlux(texte, largeur = COLS) {
  const lignes = [];
  let reste = String(texte);

  // les retours a la ligne explicites ferment la ligne courante
  let nl;
  while ((nl = reste.indexOf("\n")) !== -1) {
    const avant = reste.slice(0, nl);
    if (avant === "") lignes.push("");
    else for (const l of wrap(avant, largeur)) lignes.push(l);
    reste = reste.slice(nl + 1);
  }

  // on n'emet une ligne que lorsqu'on est certain que rien de plus n'y tiendra
  while (reste.length > largeur) {
    let coupe = reste.lastIndexOf(" ", largeur);
    if (coupe <= 0) coupe = largeur;             // mot plus long qu'une ligne
    lignes.push(reste.slice(0, coupe).trimEnd());
    reste = reste.slice(coupe).replace(/^ +/, "");
  }

  return { lignes, reste };
}

/** Centre un texte sur la largeur de l'ecran. */
export function centrer(texte, largeur = COLS) {
  const t = String(texte).slice(0, largeur);
  return " ".repeat(Math.max(0, Math.floor((largeur - t.length) / 2))) + t;
}

/** Flux d'octets clavier -> evenements {type:"car"|"touche", valeur}. */
export function* decoderClavier(buf, etat) {
  for (const octet of buf) {
    if (etat.attente === "SEP") {
      etat.attente = null;
      yield { type: "touche", valeur: TOUCHE[octet] ?? `0x${octet.toString(16)}` };
      continue;
    }
    if (etat.attente === "SS2") {
      etat.attente = null;
      if (DIACRITIQUE_PAR_CODE[octet] !== undefined) etat.accent = octet;
      else if (G2_PAR_CODE[octet] !== undefined) yield { type: "car", valeur: G2_PAR_CODE[octet] };
      continue;
    }
    if (etat.accent != null) {
      const diacritique = DIACRITIQUE_PAR_CODE[etat.accent];
      etat.accent = null;
      yield { type: "car", valeur: (String.fromCharCode(octet) + diacritique).normalize("NFC") };
      continue;
    }

    if (octet === VT.SEP) etat.attente = "SEP";
    else if (octet === VT.SS2) etat.attente = "SS2";
    else if (octet === VT.CR) yield { type: "touche", valeur: "ENVOI" };
    else if (octet === VT.BS) yield { type: "touche", valeur: "CORRECTION" };
    else if (octet >= 0x20 && octet <= 0x7e) yield { type: "car", valeur: String.fromCharCode(octet) };
  }
}

/**
 * Emetteur cadence.
 * A 1200 bauds le Minitel n'avale que ~120 octets/s. Envoyer plus vite fait
 * deborder le buffer UART de l'ESP32 : octets perdus, sequences SS2 tronquees,
 * affichage corrompu. On lisse donc le debit cote serveur.
 */
export class EmetteurCadence {
  #timer;
  constructor(ws, bauds) {
    this.ws = ws;
    this.octetsParTick = Math.max(1, Math.floor((bauds / 10) * 0.05 * 0.9)); // 50 ms, marge 10 %
    this.file = [];
    this.#timer = setInterval(() => this.#vider(), 50);
  }
  envoyer(buf) { if (buf?.length) this.file.push(buf); }
  purger() { this.file = []; }
  get enAttente() { return this.file.reduce((n, b) => n + b.length, 0); }
  #vider() {
    if (!this.file.length || this.ws.readyState !== this.ws.OPEN) return;
    let budget = this.octetsParTick;
    const paquet = [];
    while (budget > 0 && this.file.length) {
      const tete = this.file[0];
      if (tete.length <= budget) { paquet.push(this.file.shift()); budget -= tete.length; }
      else { paquet.push(tete.subarray(0, budget)); this.file[0] = tete.subarray(budget); budget = 0; }
    }
    if (paquet.length) this.ws.send(Buffer.concat(paquet), { binary: true });
  }
  arreter() { clearInterval(this.#timer); this.file = []; }
}
