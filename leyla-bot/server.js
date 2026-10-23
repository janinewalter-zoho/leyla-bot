// Leyla — webhook Zobot pour Zoho SalesIQ (Node ≥ 20, aucune dépendance)
// Reçoit les événements SalesIQ (trigger / message / context), appelle Claude et répond
// au format SalesIQ ({ action: "reply", replies, suggestions } | forward | end).
// Contraintes SalesIQ : réponse en moins de 5 s, HTTPS public sans port, HEAD -> 200.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuration (variables d'environnement) ----------
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5"; // rapide : budget 5 s SalesIQ
const BOOKING_URL = process.env.BOOKING_URL || "https://english4french.com/rendez-vous-conseilleres-formation";
const BOOKING_URL_ISLE = process.env.BOOKING_URL_ISLE || "https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ1afbfwpzbOZDsHUvGYYj2exb3EdJQlvE4U-Y1p3VgNZ35nJxUphjwRfyBHnPw6rma4Q4VIE_YY"; // Alexandra, centre de L'Isle-sur-la-Sorgue (particuliers)
const TEST_URL = process.env.TEST_URL || "https://english4french.typeform.com/BannieresiteE4F";
const FORWARD_OPERATORS = (process.env.FORWARD_OPERATORS || "").split(",").map(s => s.trim()).filter(Boolean);
const SIQ_PUBLIC_KEY = process.env.SIQ_PUBLIC_KEY || "";   // clé publique « Secure your webhook » (optionnel)
const CALLBACK_URL = process.env.CALLBACK_URL || ""; // fonction CRM leyla_rappel (clé API) : demandes de rappel
const LEAD_WEBHOOK_URL = process.env.LEAD_WEBHOOK_URL || ""; // Zoho Flow / CRM : reçoit le profil en fin de chat (optionnel)
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 4600);
const MAX_TURNS = 24;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

if (!API_KEY) { console.error("ANTHROPIC_API_KEY manquante"); process.exit(1); }

// ---------- Prompt système : prompt.md + base de connaissances ----------
function loadKnowledge() {
  const dir = path.join(__dirname, "knowledge");
  return fs.readdirSync(dir).filter(f => f.endsWith(".txt")).sort()
    .map(f => `--- ${f} ---\n${fs.readFileSync(path.join(dir, f), "utf8").trim()}`)
    .join("\n\n");
}
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8")
  .replaceAll("{{BOOKING_URL}}", BOOKING_URL)
  .replaceAll("{{TEST_URL}}", TEST_URL)
  .replace("{{KNOWLEDGE}}", loadKnowledge());

// ---------- Horaires des centres (pour « Appeler maintenant ») ----------
// jours : 1 = lundi … 5 = vendredi ; plages en minutes depuis minuit. Jours fériés non gérés.
const H = (h, m = 0) => h * 60 + m;
const CENTRES = [
  { nom: "L'Isle-sur-la-Sorgue", tel: "04 90 26 36 81", j: { 1: [[H(9), H(13)], [H(14), H(17)]], 2: [[H(9), H(13)], [H(14), H(19)]], 3: [[H(9), H(13)], [H(14), H(17)]], 4: [[H(9), H(13)], [H(14), H(17)]], 5: [[H(9), H(13)], [H(14), H(17)]] } },
  { nom: "Saint-Rémy-de-Provence (siège)", tel: "04 32 61 11 01", j: { 1: [[H(9), H(13)], [H(13, 45), H(17, 30)]], 2: [[H(9), H(13)], [H(13, 45), H(17, 30)]], 3: [[H(9), H(13)], [H(13, 45), H(17, 30)]], 4: [[H(9), H(13)], [H(13, 45), H(17, 30)]], 5: [[H(9), H(12)]] } },
  { nom: "Sophia Antipolis", tel: "06 85 38 81 09", j: { 1: [[H(9), H(18)]], 2: [[H(9), H(18)]], 4: [[H(9), H(18)]], 5: [[H(9), H(16)]] } },
  { nom: "Paris 11e", tel: "06 85 38 81 09", j: { 1: [[H(10), H(18)]], 2: [[H(10), H(18)]], 3: [[H(10), H(18)]], 4: [[H(10), H(18)]], 5: [[H(10), H(18)]] } },
];
function nowParis() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const jour = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { jour, min: Number(p.hour) * 60 + Number(p.minute) };
}
function centresNote() {
  const { jour, min } = nowParis();
  const ouverts = [], fermes = [];
  for (const c of CENTRES) ((c.j[jour] || []).some(([a, b]) => min >= a && min < b) ? ouverts : fermes).push(`${c.nom} (${c.tel})`);
  return `\nCentres ouverts à cet instant : ${ouverts.length ? ouverts.join(", ") : "aucun"}.\nCentres fermés à cet instant : ${fermes.length ? fermes.join(", ") : "aucun"}.`;
}

// ---------- Sessions en mémoire (par visiteur) ----------
const sessions = new Map();
function getSession(id) {
  const now = Date.now();
  let s = sessions.get(id);
  if (!s || now - s.updated > SESSION_TTL_MS) { s = { messages: [], updated: now }; sessions.set(id, s); }
  s.updated = now;
  return s;
}
setInterval(() => { const now = Date.now(); for (const [k, s] of sessions) if (now - s.updated > SESSION_TTL_MS) sessions.delete(k); }, 600000).unref();

// ---------- Vérification de signature SalesIQ (optionnelle) ----------
function verifySignature(rawBody, signature) {
  if (!SIQ_PUBLIC_KEY) return true;
  if (!signature) return false;
  try { const v = crypto.createVerify("RSA-SHA256"); v.update(rawBody); return v.verify(SIQ_PUBLIC_KEY, signature, "base64"); }
  catch { return false; }
}

// ---------- Analyse de la réponse du modèle ----------
function parseModelOutput(text) {
  let action = "reply", suggestions = [], callback = null;
  const kept = [];
  for (const line of text.trim().split("\n")) {
    const t = line.trim();
    if (/^SUGGESTIONS\s*:/i.test(t)) suggestions = t.replace(/^SUGGESTIONS\s*:/i, "").split("|").map(s => s.trim()).filter(Boolean).slice(0, 3);
    else if (/^RAPPEL\s*:/i.test(t)) { try { callback = JSON.parse(t.replace(/^RAPPEL\s*:/i, "").trim().replace(/^`|`$/g, "")); } catch (e) { console.error("RAPPEL JSON invalide", e.message); } }
    else if (/^ACTION\s*:\s*FORWARD/i.test(t)) action = "forward";
    else if (/^ACTION\s*:\s*END/i.test(t)) action = "end";
    else kept.push(line);
  }
  const reply = (kept.join("\n").trim() || "Je vous écoute.").replaceAll("[RDV_ALEXANDRA]", BOOKING_URL_ISLE);
  return { action, reply, suggestions, callback };
}

// ---------- Appel au modèle (API Messages, fetch natif) ----------
async function askLeyla(session, userText, visitor) {
  session.messages.push({ role: "user", content: userText });
  if (session.messages.length > MAX_TURNS) session.messages.splice(0, session.messages.length - MAX_TURNS);

  const ctx = {};
  for (const k of ["name", "email", "phone", "current_page", "city"]) if (visitor && visitor[k]) ctx[k] = visitor[k];
  const visitorNote = Object.keys(ctx).length ? `\n\n# Contexte visiteur (SalesIQ)\n${JSON.stringify(ctx)}` : "";
  const nowNote = `\n\n# Date et heure actuelles\n${new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" }).format(new Date())} (heure de Paris)${centresNote()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2000, output_config: { effort: "low" }, // la réflexion compte dans max_tokens
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }, { type: "text", text: (visitorNote + nowNote).trim() }],
        messages: session.messages,
      }),
    });
    if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    console.log(`[model] stop=${data.stop_reason} out=${data.usage?.output_tokens} cache_read=${data.usage?.cache_read_input_tokens || 0} cache_write=${data.usage?.cache_creation_input_tokens || 0}`);
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    session.messages.push({ role: "assistant", content: text });
    return parseModelOutput(text);
  } finally { clearTimeout(timer); }
}

// ---------- Réponses SalesIQ ----------
const siqReply = (reply, suggestions) => ({ action: "reply", replies: [reply], ...(suggestions?.length ? { suggestions } : {}) });
const siqForward = reply => ({ action: "forward", replies: [reply], ...(FORWARD_OPERATORS.length ? { operators: FORWARD_OPERATORS } : {}) });
const siqEnd = reply => ({ action: "end", replies: [reply] });

const WELCOME = "Bonjour ! Je suis Leyla, l'assistante virtuelle d'English 4 French. Je suis une intelligence artificielle formée sur nos formations, nos financements et nos plannings. Je peux répondre à vos questions, évaluer votre niveau d'anglais et vous préparer une proposition. Comment préférez-vous continuer ?";
const WELCOME_SUGGESTIONS = ["Je me forme moi-même", "Former mes salariés", "Faire le test de niveau"];
const FALLBACK = "Je rencontre un petit souci technique. Vous pouvez réserver directement un rendez-vous de 15 minutes avec Lucile, notre conseillère : " + BOOKING_URL;

const cleanTranscript = session => session.messages.map(m => `${m.role === "user" ? "Visiteur" : "Leyla"} : ${String(m.content).split("\n").filter(l => !/^(SUGGESTIONS|RAPPEL|ACTION)\s*:/i.test(l.trim())).join("\n").trim()}`).join("\n");

async function sendCallback(session, visitor, cb) {
  if (!CALLBACK_URL) { console.error("CALLBACK_URL manquante : rappel non transmis", JSON.stringify(cb)); return; }
  try {
    const payload = { ...cb, transcript: cleanTranscript(session), page: visitor.current_page || "" };
    if (!payload.email && visitor.email) payload.email = visitor.email;
    const r = await fetch(CALLBACK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    console.log(`[rappel] ${cb.conseillere} ${r.status} ${(await r.text()).slice(0, 120)}`);
  } catch (e) { console.error("sendCallback", e.message); }
}

async function pushLead(session, visitor) {
  if (!LEAD_WEBHOOK_URL) return;
  try {
    const transcript = session.messages.map(m => `${m.role === "user" ? "Visiteur" : "Leyla"} : ${m.content}`).join("\n");
    await fetch(LEAD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visitor, transcript, ended_at: new Date().toISOString() }) });
  } catch (e) { console.error("pushLead", e.message); }
}

// ---------- Traitement d'un événement SalesIQ ----------
async function handleSalesIQ(body, rawBody, signature) {
  if (!verifySignature(rawBody, signature)) return { status: 401, json: { error: "bad signature" } };
  const handler = body.handler || body.request?.handler || "";
  const visitor = body.visitor || {};
  const msg = body.message ?? body.request?.message;
  const text = String((typeof msg === "string" ? msg : (msg?.text ?? msg?.value ?? "")) || body.text || "").trim();
  console.log(`[siq] handler=${handler} op=${body.operation || ""} keys=${Object.keys(body).join(",")} msg=${JSON.stringify(msg ?? null).slice(0, 300)}`);
  const sessionId = visitor.active_conversation_id || visitor.id || visitor.uvid || visitor.email || "anon";
  const session = getSession(sessionId);
  const started = Date.now();
  try {
    if (!text && handler === "trigger") return { status: 200, json: siqReply(WELCOME, WELCOME_SUGGESTIONS) };
    if (text) {
      if (session.messages.length === 0) session.messages.push({ role: "assistant", content: WELCOME });
      const { action, reply, suggestions, callback } = await askLeyla(session, text, visitor);
      if (callback && !session.callbackSent) { session.callbackSent = true; sendCallback(session, visitor, callback); }
      console.log(`[${sessionId}] ${action} ${Date.now() - started}ms`);
      if (action === "forward") { pushLead(session, visitor); return { status: 200, json: siqReply(reply, suggestions) }; } // pas de transfert en direct : on reste sur une réponse
      if (action === "end") { pushLead(session, visitor); sessions.delete(sessionId); return { status: 200, json: siqEnd(reply) }; }
      return { status: 200, json: siqReply(reply, suggestions) };
    }
    return { status: 200, json: siqReply(WELCOME, WELCOME_SUGGESTIONS) };
  } catch (e) {
    console.error(`[${sessionId}] ${e.name}: ${e.message}`);
    return { status: 200, json: siqReply(FALLBACK, ["Réserver un RDV avec Lucile"]) };
  }
}

// ---------- Serveur HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

  if (req.method === "HEAD") { res.writeHead(200); return res.end(); }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) return send(200, { ok: true, bot: "Leyla", model: MODEL, sessions: sessions.size });
  if (req.method === "POST" && url.pathname === "/salesiq") {
    const chunks = [];
    req.on("data", c => { chunks.push(c); if (Buffer.concat(chunks).length > 1e6) req.destroy(); });
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { return send(400, { error: "bad json" }); }
      const out = await handleSalesIQ(body, raw, req.headers["x-siqsignature"]);
      send(out.status, out.json);
    });
    return;
  }
  send(404, { error: "not found" });
});
server.listen(PORT, () => console.log(`Leyla webhook prêt sur le port ${PORT} (modèle ${MODEL})`));
