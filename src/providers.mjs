/**
 * Backends LLM.
 *
 * Deux protocoles couvrent tout le paysage :
 *   - "anthropic" : POST /v1/messages, en-tetes x-api-key + anthropic-version.
 *   - "openai"    : POST /v1/chat/completions, en-tete Authorization: Bearer.
 *
 * Le second est devenu le denominateur commun : OpenAI, Mistral, Groq,
 * OpenRouter, DeepSeek, Together, l'endpoint de compatibilite de Gemini, et
 * surtout Ollama / LM Studio / llama.cpp en reseau local l'implementent tous.
 * Un serveur local se declare donc comme n'importe quel autre service, en
 * changeant simplement baseUrl.
 *
 * Aucune dependance : tout passe par fetch et un lecteur SSE maison.
 */

/** Lit un flux SSE et rend les charges utiles `data:` une par une. */
async function* lireSSE(reponse) {
  const lecteur = reponse.body.getReader();
  const decodeur = new TextDecoder();
  let tampon = "";
  try {
    while (true) {
      const { done, value } = await lecteur.read();
      if (done) break;
      tampon += decodeur.decode(value, { stream: true });
      // les evenements SSE sont separes par une ligne vide
      let coupe;
      while ((coupe = tampon.search(/\r?\n\r?\n/)) !== -1) {
        const bloc = tampon.slice(0, coupe);
        tampon = tampon.slice(coupe).replace(/^\r?\n\r?\n/, "");
        const donnees = bloc
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (donnees) yield donnees;
      }
    }
  } finally {
    lecteur.cancel().catch(() => {});
  }
}

function json(texte) {
  try { return JSON.parse(texte); } catch { return null; }
}

/** Transforme une reponse HTTP en erreur lisible sur 40 colonnes. */
async function erreurHTTP(reponse, service) {
  let detail = "";
  try {
    const corps = await reponse.text();
    const obj = json(corps);
    detail = obj?.error?.message ?? obj?.message ?? corps.slice(0, 300);
  } catch { /* corps illisible */ }
  return new Error(`${service.nom} HTTP ${reponse.status} : ${detail || reponse.statusText}`);
}

// ---------------------------------------------------------------------------

class BackendAnthropic {
  constructor(service) {
    this.service = service;
    this.baseUrl = service.baseUrl ?? "https://api.anthropic.com";
  }
  async *stream(messages, system, signal) {
    const s = this.service;
    const enTetes = {
      "content-type": "application/json",
      "anthropic-version": s.version ?? "2023-06-01",
      "x-api-key": s.apiKey,
    };
    // Une cle liee a une identite et couvrant plusieurs espaces de travail doit
    // nommer l'espace cible, sinon l'API repond 400 invalid_request_error.
    if (s.workspaceId) enTetes["anthropic-workspace-id"] = s.workspaceId;

    const reponse = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: enTetes,
      signal,
      body: JSON.stringify({
        model: s.model,
        max_tokens: s.maxTokens ?? 500,
        temperature: s.temperature,
        system,
        messages,
        stream: true,
      }),
    });
    if (!reponse.ok) throw await erreurHTTP(reponse, s);

    for await (const brut of lireSSE(reponse)) {
      const ev = json(brut);
      if (!ev) continue;
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield ev.delta.text;
      if (ev.type === "error") throw new Error(ev.error?.message ?? "erreur de flux");
    }
  }
}

class BackendOpenAI {
  constructor(service) {
    this.service = service;
    this.baseUrl = (service.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }
  async *stream(messages, system, signal) {
    const s = this.service;
    const enTetes = { "content-type": "application/json" };
    // Les serveurs locaux n'exigent pas de cle ; on n'envoie l'en-tete que si
    // on en a une, certains la refusent quand elle est vide.
    if (s.apiKey) enTetes["authorization"] = `Bearer ${s.apiKey}`;

    const reponse = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: enTetes,
      signal,
      body: JSON.stringify({
        model: s.model,
        max_tokens: s.maxTokens ?? 500,
        temperature: s.temperature,
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
        stream: true,
      }),
    });
    if (!reponse.ok) throw await erreurHTTP(reponse, s);

    for await (const brut of lireSSE(reponse)) {
      if (brut === "[DONE]") return;
      const ev = json(brut);
      if (!ev) continue;
      if (ev.error) throw new Error(ev.error.message ?? "erreur de flux");
      const delta = ev.choices?.[0]?.delta;
      // certains serveurs locaux renvoient un raisonnement separe : on l'ignore
      if (typeof delta?.content === "string" && delta.content) yield delta.content;
    }
  }
}

const BACKENDS = { anthropic: BackendAnthropic, openai: BackendOpenAI };

export function creerBackend(service) {
  const Classe = BACKENDS[service.kind];
  if (!Classe) throw new Error(`protocole inconnu : ${service.kind}`);
  return new Classe(service);
}

export const PROTOCOLES = Object.keys(BACKENDS);
