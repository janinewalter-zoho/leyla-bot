// Déroulé du test de niveau dans le chat SalesIQ : collecte des coordonnées, questions une par une,
// résultat, 3 points à améliorer, parcours et rendez-vous. Aucune IA : tout est calculé ici, en < 5 ms.
//
// Utilisation depuis server.js :
//   if (wantsTest(text)) startTest(session, visitor)
//   if (session.test) { const out = stepTest(session, text, opts); ... }
// `out` : { replies: string[], suggestions: string[], done?: boolean, result?: object, exited?: boolean }

import * as E from "./engine.js";

export const SITES = ["Saint-Rémy-de-Provence", "L'Isle-sur-la-Sorgue", "Paris 11e", "Sophia Antipolis", "100 % en ligne"];
export const DK = "Je ne sais pas";
const STOP_RE = /^(stop|arr[êe]ter?( le test)?|quitter|annuler|abandonner)\b/i;
const DK_RE = /^(\?|jsp|je (ne )?sais pas|aucune id[ée]e|pass(e|er)?)\s*[.!]?$/i;

// Déclenché seulement par une demande explicite de test (pas « améliorer mon niveau », pas le TOEIC).
const TEST_RE = /\btest(s)? de niveau\b|\b(faire|passer|lancer|commencer|refaire)\b.{0,20}\btest\b|\b(tester|[ée]valuer|v[ée]rifier|conna[iî]tre)\b.{0,12}\bmon niveau\b|quel est mon niveau/i;
export const wantsTest = text => TEST_RE.test(text || "") && !/toeic|toefl|ielts|linguaskill|bright|bulats|cambridge|90 questions|tdn90/i.test(text || "");

const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

function matchSite(text) {
  const t = norm(text);
  if (/ligne|distance|visio|chez moi|en\s*ligne/.test(t)) return "100 % en ligne";
  if (/isle|sorgue/.test(t)) return "L'Isle-sur-la-Sorgue";
  if (/remy|st[- ]remy/.test(t)) return "Saint-Rémy-de-Provence";
  if (/paris/.test(t)) return "Paris 11e";
  if (/sophia|antipolis|biot|valbonne/.test(t)) return "Sophia Antipolis";
  return null;
}

export function startTest(session, visitor = {}) {
  const lead = {
    first: "", last: "", email: visitor.email || "", phone: visitor.phone || "", site: "",
  };
  if (visitor.name && !/^(visitor|visiteur)/i.test(visitor.name)) { const [f, ...r] = String(visitor.name).trim().split(/\s+/); lead.first = f; lead.last = r.join(" "); }
  session.test = { stage: "lead", lead, ask: null, engine: null, current: null, startedAt: Date.now() };
  return askNextLead(session.test);
}

function askNextLead(t) {
  const L = t.lead;
  if (!L.first) { t.ask = "name"; return reply("Avec plaisir ! Le test prend 7 à 10 minutes : 18 à 22 questions qui s'adaptent à vos réponses, et votre niveau s'affiche à la fin.\n\nPour commencer, quel est votre prénom et votre nom ?"); }
  if (!L.email) { t.ask = "email"; return reply(`Merci ${L.first}. Quelle est votre adresse e-mail, pour que notre conseillère puisse vous recontacter avec votre résultat ?`); }
  if (!L.phone) { t.ask = "phone"; return reply("Et votre numéro de téléphone, pour qu'une conseillère puisse vous rappeler si vous le souhaitez ?"); }
  if (!L.site) { t.ask = "site"; return reply("Dernière question avant le test : où souhaitez-vous vous former ?", ["100 % en ligne", "Saint-Rémy-de-Provence", "Autre centre"]); }
  return startQuestions(t);
}

function startQuestions(t) {
  t.stage = "q";
  t.engine = E.newState();
  const q = askQuestion(t);
  q.replies.unshift("C'est parti ! Répondez spontanément. Si vous ne savez pas, cliquez ou écrivez « Je ne sais pas » plutôt que de deviner : le résultat sera plus juste. Vous pouvez écrire « stop » à tout moment.");
  return q;
}

function askQuestion(t) {
  const i = E.pickItem(t.engine);
  const item = E.ITEMS[i];
  const opts = E.optionsFor(item, t.engine);
  t.current = { i, opts };
  const n = t.engine.hist.length + 1;
  const instr = item.kind === "error" ? "Cette phrase contient une erreur. Quel mot est incorrect ?" : "Complétez la phrase.";
  const text = `Question ${n} · ${item.cat}\n${instr}\n\n${item.q.replace(/_{3,}/g, "_____")}\n\n` + opts.map((o, k) => `${k + 1}. ${o.text}`).join("\n") + `\n\n(Répondez par le numéro, ou « ${DK} »)`;
  return reply(text, opts.map(o => o.text).slice(0, 3));
}

export function stepTest(session, text, opts = {}) {
  const t = session.test;
  const raw = String(text || "").trim();
  if (STOP_RE.test(raw)) { delete session.test; return { ...reply("Pas de souci, j'arrête le test. Vous pourrez le reprendre quand vous voulez en écrivant « test de niveau »."), exited: true }; }

  if (t.stage === "lead") {
    const L = t.lead;
    if (t.ask === "name") { const [f, ...r] = raw.split(/\s+/); if (!f || f.length < 2) return reply("Je n'ai pas bien saisi. Quel est votre prénom et votre nom ?"); L.first = cap(f); L.last = r.join(" "); }
    else if (t.ask === "email") { const m = raw.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/); if (!m) return reply("L'adresse semble incomplète. Pouvez-vous me redonner votre e-mail ?"); L.email = m[0]; }
    else if (t.ask === "phone") { const d = raw.replace(/\D/g, ""); if (d.length < 9) return reply("Le numéro semble incomplet. Pouvez-vous me redonner votre téléphone ?"); L.phone = raw; }
    else if (t.ask === "site") {
      if (/autre/i.test(raw)) return reply("Quel centre ?", ["L'Isle-sur-la-Sorgue", "Paris 11e", "Sophia Antipolis"]);
      const s = matchSite(raw); if (!s) return reply("Je n'ai pas reconnu ce lieu. Choisissez : 100 % en ligne, Saint-Rémy-de-Provence, L'Isle-sur-la-Sorgue, Paris 11e ou Sophia Antipolis.", ["100 % en ligne", "Saint-Rémy-de-Provence", "Autre centre"]);
      L.site = s;
    }
    return askNextLead(t);
  }

  if (t.stage === "q") {
    const { i, opts: options } = t.current;
    let chosen = null, dk = false;
    if (DK_RE.test(raw) || norm(raw) === norm(DK)) dk = true;
    else {
      const num = raw.match(/^\s*(\d)\s*[.)]?\s*$/);
      if (num && options[+num[1] - 1]) chosen = options[+num[1] - 1];
      else chosen = options.find(o => norm(o.text) === norm(raw)) || options.find(o => norm(raw).includes(norm(o.text)) && o.text.length > 2) || null;
    }
    if (!dk && !chosen) return reply(`Répondez par le numéro (1 à ${options.length}), ou « ${DK} ».`, options.map(o => o.text).slice(0, 3));
    E.answer(t.engine, i, !!(chosen && chosen.correct));
    if (!E.isDone(t.engine)) return askQuestion(t);
    return finish(session, opts);
  }
  return askNextLead(t);
}

function finish(session, opts) {
  const t = session.test;
  const r = E.result(t.engine);
  const L = t.lead;
  const booking = L.site === "L'Isle-sur-la-Sorgue" ? (opts.bookingIsle || "") : (opts.booking || "");
  const who = L.site === "L'Isle-sur-la-Sorgue" ? "Alexandra, conseillère du centre de L'Isle-sur-la-Sorgue" : "Lucile, notre conseillère formation";
  const secs = Math.round((Date.now() - t.startedAt) / 1000);

  const m1 = `Bravo ${L.first}, c'est terminé !\n\n🎯 Votre niveau : ${r.level} · ${r.title}\nScore : ${r.score}/100 (${r.position}).\n${r.description}\n\n(${r.nCorrect} bonne${r.nCorrect > 1 ? "s" : ""} réponse${r.nCorrect > 1 ? "s" : ""} sur ${r.nQuestions})`;
  const m2 = `3 points à améliorer avec English 4 French, d'après vos réponses :\n` + r.points.map((p, k) => `${k + 1}. ${p.name}${p.errors ? ` (${p.errors} erreur${p.errors > 1 ? "s" : ""})` : ""} — ${p.tip}`).join("\n");
  const fmt = L.site === "100 % en ligne" ? "100 % en ligne, avec un formateur en direct" : `en centre à ${L.site}`;
  const m3 = `Trois parcours ${fmt}, selon votre objectif :\n` + r.courses.map(c => `• ${c.title} (${c.why}) : ${c.url}`).join("\n") +
    (booking ? `\n\nVous hésitez ? Réservez 15 minutes avec ${who} : ${booking}` : "");

  const result = { ...L, ...r, points: r.points.map(p => p.name), seconds: secs, at: new Date().toISOString(), source: "leyla" };
  delete session.test;
  session.testResult = result;
  // Note de contexte pour Leyla : elle continue la conversation en connaissant le résultat.
  session.messages.push({ role: "user", content: `[Test de niveau effectué dans le chat] Prénom : ${L.first} ${L.last}. E-mail : ${L.email}. Téléphone : ${L.phone}. Lieu souhaité : ${L.site}. Niveau estimé : ${r.level}, score ${r.score}/100 (${r.position} ; ${r.nCorrect}/${r.nQuestions}). Points à travailler : ${result.points.join(" ; ")}.` });
  session.messages.push({ role: "assistant", content: `Merci ${L.first}, votre niveau estimé est ${r.level}. Je reste disponible pour vos questions ou pour organiser un rendez-vous.` });

  return { replies: [m1, m2, m3], suggestions: ["Réserver 15 minutes", "Les tarifs CPF", "J'ai une question"], done: true, result };
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const reply = (text, suggestions = []) => ({ replies: [text], suggestions: suggestions.slice(0, 3) });
