// Moteur du test de niveau adaptatif (TDNA) — logique pure, sans dépendance, sans appel réseau.
// Banque : 74 questions du TDN 90 d'E4F, calibrées (modèle 2PL) sur 1 237 passages réels.
// Estimation du niveau par EAP sur une grille ; arrêt dès que l'estimation est stable.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ITEMS = JSON.parse(fs.readFileSync(path.join(__dirname, "items.json"), "utf8"));
export const SKILLS = JSON.parse(fs.readFileSync(path.join(__dirname, "skills.json"), "utf8"));

export const CONFIG = {
  MIN_Q: 14, MAX_Q: 18, SE_STOP: 0.33,
  // Seuils de niveau (theta), calibrés sur la distribution des 1 237 candidats du TDN 90.
  CUTS: [-0.75, -0.10, 0.55, 1.20], LEVELS: ["A1", "A2", "B1", "B2", "C1"],
  B1_PLUS_THETA: 0.95, // au-dessus : « bon B1 », orienté Advanced
  MAX_OPTIONS: 3,      // nombre de réponses proposées (SalesIQ : 3 boutons max)
};

export const LEVEL_TEXT = {
  A1: ["Débutant", "Vous connaissez quelques mots et structures de base. Une formation « grands débutants » vous donnera des fondations solides."],
  A2: ["Élémentaire", "Vous comprenez des phrases simples du quotidien. L'étape suivante : gagner en aisance et en vocabulaire pour tenir une conversation."],
  B1: ["Intermédiaire", "Vous vous débrouillez dans la plupart des situations courantes. Objectif : fluidité, précision des temps et vocabulaire professionnel."],
  B2: ["Intermédiaire avancé", "Vous communiquez avec aisance et nuance. Vous pouvez viser une certification (TOEIC, CLOE) et l'anglais professionnel avancé."],
  C1: ["Avancé", "Vous maîtrisez les structures complexes de l'anglais écrit. Un bilan oral avec un formateur confirmera votre niveau global."],
};

export const COURSES = {
  level: {
    A1: { title: "Anglais Pré-rentrée", url: "https://english4french.com/les-ateliers-2021/pre-rentree-complet" },
    A2: { title: "Anglais Complet", url: "https://english4french.com/les-ateliers-2021/anglais-complet" },
    B1: { title: "Anglais Complet", url: "https://english4french.com/les-ateliers-2021/anglais-complet" },
    B1plus: { title: "Anglais Advanced", url: "https://english4french.com/les-ateliers-2021/advanced" },
    B2: { title: "Anglais Advanced", url: "https://english4french.com/les-ateliers-2021/advanced" },
    C1: { title: "Anglais Advanced", url: "https://english4french.com/les-ateliers-2021/advanced" },
  },
  pro: { title: "Anglais Professionnel", url: "https://english4french.com/les-ateliers-2021/anglais-professionnel" },
  cert: { title: "Certification TOEIC ou CLOE", url: "https://english4french.com/tarifs-cpf" },
};

// Compétences « prochaine étape » quand le candidat a fait moins de 3 erreurs.
const NEXT_STEPS = {
  A1: ["present3", "prep", "questions"], A2: ["preterit", "presperf", "futur"], B1: ["presperf", "passif", "gerinf"],
  B2: ["pastperf", "wish", "phrasal"], C1: ["cond3", "causatif", "indirect"],
};

const GRID = []; for (let t = -4; t <= 4.0001; t += 0.1) GRID.push(+t.toFixed(2));
const PRIOR = GRID.map(t => Math.exp(-0.5 * t * t));
const P = (a, b, t) => 1 / (1 + Math.exp(-a * (t - b)));

export function newState(rng = Math.random) {
  return { used: [], logL: GRID.map(() => 0), theta: 0, se: 1, hist: [], rng };
}

// Choisit la question suivante : la plus informative au niveau estimé (parmi les 3 meilleures, au hasard,
// pour que deux candidats n'aient pas exactement le même test). La première est volontairement facile.
export function pickItem(state) {
  const first = state.hist.length === 0;
  const used = new Set(state.used);
  const scored = ITEMS.map((it, i) => {
    if (used.has(i)) return { i, info: -1 };
    const p = P(it.a, it.b, state.theta);
    let info = it.a * it.a * p * (1 - p);
    if (first && it.b >= -0.3) info = -1;
    return { i, info };
  }).filter(x => x.info > 0).sort((x, y) => y.info - x.info);
  const top = scored.slice(0, first ? 1 : 3);
  return top[Math.floor(state.rng() * top.length)].i;
}

// Réponses à afficher : la bonne + les distracteurs les plus fréquents, dans un ordre mélangé.
export function optionsFor(item, state, max = CONFIG.MAX_OPTIONS) {
  let opts = item.opts.map((text, k) => ({ text, correct: k === item.ans }));
  if (opts.length > max) { // les distracteurs sont rangés du plus au moins fréquent : on retire les derniers
    const keep = [opts[item.ans]]; for (const o of opts) if (!o.correct && keep.length < max) keep.push(o);
    opts = keep;
  }
  for (let k = opts.length - 1; k > 0; k--) { const j = Math.floor(state.rng() * (k + 1)); [opts[k], opts[j]] = [opts[j], opts[k]]; }
  return opts;
}

export function answer(state, itemIndex, correct) {
  const it = ITEMS[itemIndex];
  state.used.push(itemIndex);
  GRID.forEach((t, k) => { const p = P(it.a, it.b, t); state.logL[k] += Math.log(correct ? p : 1 - p); });
  const m = Math.max(...state.logL);
  let post = state.logL.map((l, k) => Math.exp(l - m) * PRIOR[k]); const z = post.reduce((a, b) => a + b, 0); post = post.map(x => x / z);
  state.theta = GRID.reduce((s, t, k) => s + t * post[k], 0);
  state.se = Math.sqrt(GRID.reduce((s, t, k) => s + (t - state.theta) ** 2 * post[k], 0));
  state.hist.push({ id: it.id, cat: it.cat, s: it.s, b: it.b, correct });
}

export const isDone = state => { const n = state.hist.length; return n >= CONFIG.MAX_Q || (n >= CONFIG.MIN_Q && state.se < CONFIG.SE_STOP); };
export const level = theta => { let k = 0; for (const c of CONFIG.CUTS) if (theta >= c) k++; return CONFIG.LEVELS[k]; };

// 3 points à améliorer : compétences ratées, d'abord celles à la portée du candidat, puis par nombre d'erreurs.
export function improvementPoints(state, lv) {
  const err = {};
  for (const h of state.hist) if (!h.correct) { (err[h.s] ||= { n: 0, reach: 0 }); err[h.s].n++; if (h.b <= state.theta + 0.6) err[h.s].reach++; }
  const ranked = Object.entries(err).sort((a, b) => (b[1].reach - a[1].reach) || (b[1].n - a[1].n));
  const out = ranked.slice(0, 3).map(([k, v]) => ({ key: k, name: SKILLS[k].name, tip: SKILLS[k].tip, errors: v.n }));
  for (const k of NEXT_STEPS[lv]) { if (out.length >= 3) break; if (!out.some(p => p.key === k)) out.push({ key: k, name: SKILLS[k].name, tip: SKILLS[k].tip, errors: 0 }); }
  return out;
}

export function courses(lv, theta) {
  const levelCourse = (lv === "B1" && theta >= CONFIG.B1_PLUS_THETA) ? COURSES.level.B1plus : COURSES.level[lv];
  return [{ ...levelCourse, why: `pour votre niveau ${lv}` }, { ...COURSES.pro, why: "objectif entreprise" }, { ...COURSES.cert, why: "objectif certification" }];
}

export function result(state) {
  const lv = level(state.theta);
  const cats = {};
  for (const h of state.hist) { (cats[h.cat] ||= { n: 0, ok: 0 }); cats[h.cat].n++; if (h.correct) cats[h.cat].ok++; }
  return {
    level: lv, title: LEVEL_TEXT[lv][0], description: LEVEL_TEXT[lv][1],
    theta: +state.theta.toFixed(2), se: +state.se.toFixed(2),
    nQuestions: state.hist.length, nCorrect: state.hist.filter(h => h.correct).length,
    categories: cats, points: improvementPoints(state, lv), courses: courses(lv, state.theta),
    answers: state.hist.map(h => `${h.id}:${h.correct ? 1 : 0}`).join(" "),
  };
}
