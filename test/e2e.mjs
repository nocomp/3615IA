// Banc de test hors ligne : simule un backend OpenAI-compatible et un Minitel.
import http from "node:http";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// --- faux serveur LLM (protocole OpenAI, flux SSE) --------------------------
const faux = http.createServer((req, res) => {
  let corps = "";
  req.on("data", (c) => (corps += c));
  req.on("end", () => {
    const demande = JSON.parse(corps);
    console.log("  [LLM] modele:", demande.model, "| messages:", demande.messages.length,
                "| system:", demande.messages[0]?.role === "system");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const morceaux = ["Bonjour ", "depuis ", "1982 ! ", "Ça marche très bien, ",
                      "où que vous soyez. ", "Voici une phrase assez longue pour ",
                      "vérifier que le retour à la ligne tombe bien sur quarante colonnes."];
    let i = 0;
    const t = setInterval(() => {
      if (i < morceaux.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: morceaux[i++] } }] })}\n\n`);
      } else { clearInterval(t); res.write("data: [DONE]\n\n"); res.end(); }
    }, 10);
  });
});
await new Promise((r) => faux.listen(9911, "127.0.0.1", r));

// --- configuration pointant sur le faux serveur -----------------------------
writeFileSync("services.json", JSON.stringify([
  { nom: "TEST-A", kind: "openai", baseUrl: "http://127.0.0.1:9911/v1", model: "faux-1", etiquette: "Banc" },
  { nom: "TEST-B", kind: "openai", baseUrl: "http://127.0.0.1:9911/v1", model: "faux-2", etiquette: "Banc" },
], null, 2));

// --- serveur 3615 IA --------------------------------------------------------
const serveur = spawn("node", ["src/server.mjs"], {
  env: { ...process.env, PORT: "9912", BAUDS: "115200" },
  stdio: ["ignore", "pipe", "inherit"],
});
serveur.stdout.on("data", (d) => process.stdout.write("  [SRV] " + d));
await new Promise((r) => setTimeout(r, 900));

// --- faux Minitel -----------------------------------------------------------
let ecran = [];
const ws = new WebSocket("ws://127.0.0.1:9912/");
ws.on("message", (d) => ecran.push(Buffer.from(d)));

const tape = (s) => ws.send(Buffer.from(s, "latin1"), { binary: true });
const envoi = () => ws.send(Buffer.from([0x13, 0x41]), { binary: true });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// Rend les octets Videotex lisibles : SS2+accent+lettre -> lettre accentuee.
function lire(bufs) {
  const o = Buffer.concat(bufs);
  const ACC = { 0x41: "\u0300", 0x42: "\u0301", 0x43: "\u0302", 0x48: "\u0308", 0x4b: "\u0327" };
  let s = "";
  for (let i = 0; i < o.length; i++) {
    const b = o[i];
    if (b === 0x19 && ACC[o[i + 1]] !== undefined) {
      s += (String.fromCharCode(o[i + 2]) + ACC[o[i + 1]]).normalize("NFC"); i += 2;
    } else if (b === 0x1b && o[i + 1] === 0x3a) i += 3;      // PRO2
    else if (b === 0x1b && o[i + 1] === 0x3b) i += 4;        // PRO3
    else if (b === 0x1b) i++;
    else if (b === 0x1f) i += 2;
    else if (b === 0x0a) s += "\n";
    else if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
  }
  return s;
}

await new Promise((r) => ws.on("open", r));
await attendre(400);
console.log("\n--- MENU " + "-".repeat(50));
console.log(lire(ecran).split("\n").map((l) => "  |" + l).join("\n"));

ecran = [];
tape("1"); envoi();
await attendre(300);
ecran = [];
tape("coucou"); envoi();
await attendre(1200);

const texte = lire(ecran);
console.log("\n--- CONVERSATION " + "-".repeat(42));
console.log(texte.split("\n").map((l) => "  |" + l).join("\n"));

// --- verifications ----------------------------------------------------------
const lignes = texte.split("\n");
const trop = lignes.filter((l) => l.length > 40);
console.log("\n--- RESULTATS " + "-".repeat(45));
console.log("  accents restitues     :", /Ça marche très\s*\n?\s*bien/.test(texte) ? "OK" : "ECHEC");
console.log("  echo de la saisie     :", texte.includes("coucou") ? "OK" : "ECHEC");
console.log("  40 colonnes respectees:", trop.length === 0 ? "OK" : "ECHEC " + JSON.stringify(trop));
console.log("  espaces preserves     :", /Bonjour depuis 1982/.test(texte) ? "OK" : "ECHEC");
console.log("  reponse complete      :", /quarante\s*\n?\s*colonnes\./.test(texte) ? "OK" : "ECHEC");

// --- clavier deporte --------------------------------------------------------
const page = await fetch("http://127.0.0.1:9912/clavier");
const html = await page.text();

const clavier = new WebSocket("ws://127.0.0.1:9912/clavier");
let etatRecu = null;
clavier.on("message", (d) => { const m = JSON.parse(d); if (m.type === "etat") etatRecu = m; });
await new Promise((r) => clavier.on("open", r));
await attendre(200);

ecran = [];
clavier.send(JSON.stringify({ type: "ligne", texte: "salut par le clavier deporte" }));
await attendre(1200);
const distant = lire(ecran);

console.log("\n--- CLAVIER DEPORTE " + "-".repeat(39));
console.log(distant.split("\n").map((l) => "  |" + l).join("\n"));
console.log("\n  page servie           :", page.status === 200 && html.includes("3615 IA") ? "OK" : "ECHEC");
console.log("  Minitel detecte       :", etatRecu?.minitel === true ? "OK" : "ECHEC");
console.log("  saisie injectee       :", distant.includes("salut par le clavier") ? "OK" : "ECHEC");
console.log("  reponse obtenue       :", distant.includes("Bonjour depuis 1982") ? "OK" : "ECHEC");

clavier.close(); ws.close(); serveur.kill(); faux.close();
process.exit(0);
