/**
 * Chargement de services.json.
 *
 * Un service n'apparait au menu du Minitel que s'il est utilisable :
 * soit il ne demande pas de cle (serveur local), soit la variable
 * d'environnement citee dans apiKeyEnv est renseignee. Inutile de proposer
 * CHATGPT a l'utilisateur si OPENAI_API_KEY n'est pas definie.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function chargerServices(chemin) {
  const candidats = chemin
    ? [resolve(chemin)]
    : [join(RACINE, "services.json"), join(RACINE, "services.example.json")];

  const fichier = candidats.find((c) => existsSync(c));
  if (!fichier) throw new Error(`aucun fichier de services trouve (${candidats.join(", ")})`);

  const brut = JSON.parse(await readFile(fichier, "utf8"));
  const liste = Array.isArray(brut) ? brut : brut.services;
  if (!Array.isArray(liste)) throw new Error(`${fichier} : tableau de services attendu`);

  const services = [];
  const ecartes = [];

  for (const s of liste) {
    if (s.actif === false) continue;
    if (!s.nom || !s.kind || !s.model) {
      ecartes.push(`${s.nom ?? "?"} (nom, kind et model sont obligatoires)`);
      continue;
    }
    const apiKey = s.apiKeyEnv ? process.env[s.apiKeyEnv] : undefined;
    if (s.apiKeyEnv && !apiKey && !s.cleFacultative) {
      ecartes.push(`${s.nom} (${s.apiKeyEnv} non definie)`);
      continue;
    }
    services.push({
      ...s,
      nom: String(s.nom).toUpperCase().slice(0, 16),
      apiKey,
      workspaceId: s.workspaceEnv ? process.env[s.workspaceEnv] : s.workspaceId,
      // permet de surcharger le modele sans toucher au JSON
      model: (s.modelEnv && process.env[s.modelEnv]) || s.model,
    });
  }

  return { fichier, services, ecartes };
}
