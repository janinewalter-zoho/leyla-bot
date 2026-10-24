// Tests du test de niveau adaptatif (moteur + déroulé chat). Lancer : npm run test:placement
// Aucune clé API ni serveur nécessaire : tout est calculé localement.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../placement/engine.js";
import { startTest, stepTest, wantsTest, DK } from "../placement/flow.js";

const P = (a, b, t) => 1 / (1 + Math.exp(-a * (t - b)));
const LV = E.CONFIG.LEVELS;

test("banque : 74 questions, chaque bonne réponse est dans les options, chaque compétence est décrite", () => {
  assert.equal(E.ITEMS.length, 74);
  for (const it of E.ITEMS) { assert.ok(it.opts[it.ans] !== undefined, `Q${it.id}`); assert.ok(E.SKILLS[it.s], `skill ${it.s}`); }
});

test("moteur : un candidat virtuel retrouve son niveau (ou le niveau voisin) en 14 à 18 questions", () => {
  let seed = 7; const rng = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  for (const theta of [-1.5, -0.75, -0.3, 0.2, 0.8, 1.5, 2.3]) {
    let same = 0, adj = 0, nq = 0; const N = 200;
    for (let k = 0; k < N; k++) {
      const s = E.newState(rng);
      while (!E.isDone(s)) { const i = E.pickItem(s); const it = E.ITEMS[i]; E.answer(s, i, rng() < P(it.a, it.b, theta)); }
      nq += s.hist.length;
      const d = Math.abs(LV.indexOf(E.level(s.theta)) - LV.indexOf(E.level(theta)));
      if (d === 0) same++; if (d <= 1) adj++;
    }
    assert.ok(nq / N >= 14 && nq / N <= 18, `nQ ${nq / N}`);
    assert.ok(adj / N >= 0.97, `theta ${theta} : ${adj / N} dans ±1 niveau`);
  }
});

test("déroulé chat : coordonnées, questions, stop, résultat, parcours et RDV", () => {
  const session = { messages: [] };
  assert.ok(wantsTest("Je veux faire le test de niveau"));
  assert.ok(wantsTest("Faire le test de niveau"));
  assert.ok(!wantsTest("Quels sont vos tarifs ?"));

  let out = startTest(session, { name: "Visitor 123" });
  assert.match(out.replies[0], /prénom et votre nom/);
  out = stepTest(session, "Marie Dupont");
  assert.match(out.replies[0], /Merci Marie/);
  out = stepTest(session, "pas d'email");
  assert.match(out.replies[0], /incomplète/);
  out = stepTest(session, "marie.dupont@example.com");
  assert.match(out.replies[0], /téléphone/);
  out = stepTest(session, "06 12 34 56 78");
  assert.deepEqual(out.suggestions, ["100 % en ligne", "Saint-Rémy-de-Provence", "Autre centre"]);
  out = stepTest(session, "Autre centre");
  assert.deepEqual(out.suggestions, ["L'Isle-sur-la-Sorgue", "Paris 11e", "Sophia Antipolis"]);
  out = stepTest(session, "L'Isle-sur-la-Sorgue");
  assert.equal(session.test.stage, "q");
  assert.equal(out.replies.length, 2); // consigne + question 1
  assert.match(out.replies[1], /^Question 1 · /);
  assert.ok(out.suggestions.length === 3 && out.suggestions.every(s => s.length <= 40));

  // stop puis reprise
  out = stepTest(session, "stop");
  assert.ok(out.exited && !session.test);
  out = startTest(session, { name: "Marie Dupont", email: "marie.dupont@example.com", phone: "0612345678" });
  assert.match(out.replies[0], /où souhaitez-vous/);
  out = stepTest(session, "en ligne");
  assert.equal(session.test.lead.site, "100 % en ligne");

  // répond toujours « 1 » (numéro) ou « Je ne sais pas » en alternance
  let n = 0, t0 = Date.now();
  while (session.test && n < 30) { out = stepTest(session, n % 2 ? DK : "1", { booking: "https://b.example/lucile", bookingIsle: "https://b.example/alex" }); n++; }
  assert.ok(Date.now() - t0 < 500, "le test complet répond en moins de 500 ms");
  assert.ok(out.done && out.result);
  const r = out.result;
  assert.ok(r.nQuestions >= 14 && r.nQuestions <= 18);
  assert.ok(LV.includes(r.level));
  assert.equal(r.points.length, 3);
  assert.equal(r.site, "100 % en ligne");
  assert.equal(out.replies.length, 3);
  assert.match(out.replies[1], /3 points à améliorer/);
  assert.match(out.replies[2], /100 % en ligne/);
  assert.match(out.replies[2], /https:\/\/b\.example\/lucile/);
  assert.doesNotMatch(out.replies[2], /alex/);
  assert.equal(out.suggestions.length, 3);
  // contexte laissé à Leyla
  assert.match(session.messages.at(-2).content, /\[Test de niveau effectué dans le chat\].*Niveau estimé : (A1|A2|B1|B2|C1)/);
  assert.ok(session.testResult && !session.test);
});

test("déroulé chat : L'Isle-sur-la-Sorgue → lien d'Alexandra ; réponse par texte acceptée", () => {
  const session = { messages: [] };
  startTest(session, { name: "Paul Martin", email: "p@example.com", phone: "0600000000" });
  let out = stepTest(session, "Isle sur la sorgue");
  let n = 0;
  while (session.test && n < 30) { out = stepTest(session, out.suggestions[0], { booking: "https://b.example/lucile", bookingIsle: "https://b.example/alex" }); n++; }
  assert.ok(out.done);
  assert.match(out.replies[2], /Alexandra/);
  assert.match(out.replies[2], /https:\/\/b\.example\/alex/);
  assert.match(out.replies[2], /en centre à L'Isle-sur-la-Sorgue/);
});
