// Simule SalesIQ : envoie une conversation au webhook local et affiche les réponses + temps.
const URL = process.env.WEBHOOK_URL || "http://localhost:3000/salesiq";
const visitor = { id: "test-visitor-1", name: "Test", current_page: "https://english4french.com/tarifs-cpf", city: "Avignon" };

async function send(payload) {
  const t = Date.now();
  const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json();
  return { ms: Date.now() - t, ...j };
}

const script = [
  "Bonjour, je voudrais améliorer mon anglais pour le travail, je suis commerciale.",
  "J'habite à Avignon. Est-ce que je peux venir en centre ?",
  "C'est quoi la différence avec une visio Zoom ?",
  "J'ai environ 1200 euros sur mon CPF, qu'est-ce que vous me conseillez ?",
  "Est-ce que je parle à une vraie personne ?",
  "Ok je veux bien un rendez-vous avec Lucile. Mon email c'est marie.dupont@example.com",
];

const r0 = await send({ handler: "trigger", visitor, org_id: "x", request: {} });
console.log(`\n[trigger ${r0.ms}ms]\nLeyla: ${r0.replies[0]}\n  → ${JSON.stringify(r0.suggestions)}`);
for (const text of script) {
  console.log(`\nVisiteur: ${text}`);
  const r = await send({ handler: "message", operation: "message", visitor, org_id: "x", message: { text }, request: {}, attachments: [] });
  console.log(`[${r.action} ${r.ms}ms]\nLeyla: ${r.replies[0]}`);
  if (r.suggestions) console.log(`  → ${JSON.stringify(r.suggestions)}`);
  if (r.ms > 5000) console.log("  !! > 5 s : SalesIQ aurait abandonné");
}
