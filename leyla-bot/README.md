# Leyla — webhook Zobot (Zoho SalesIQ)

Serveur Node sans dépendance qui fait tourner Leyla, l'assistante IA d'English 4 French, derrière un Zobot « Webhook » de Zoho SalesIQ.

## Fonctionnement
SalesIQ envoie chaque événement (`trigger` à l'ouverture, `message` à chaque message du visiteur) en POST sur `/salesiq`.
Le serveur garde l'historique par visiteur en mémoire (2 h), appelle Claude avec `prompt.md` + les fichiers de `knowledge/`, et répond au format SalesIQ :
- `{ action: "reply", replies: [...], suggestions: [...] }` : réponse + boutons de réponse rapide (max 3)
- `{ action: "forward", replies: [...], operators: [...] }` : transfert à Lucile
- `{ action: "end", replies: [...] }` : fin de conversation

Contraintes SalesIQ respectées : réponse < 5 s (timeout modèle 4,2 s puis message de secours avec lien de RDV), `HEAD` → 200, signature RSA `x-siqsignature` vérifiée si `SIQ_PUBLIC_KEY` est renseignée.

## Déploiement (Railway, Render, Fly.io, Zoho Catalyst… tout hébergeur Node ou Docker)
1. `cp .env.example .env` et renseigner les variables.
2. `npm start` (ou `docker build -t leyla . && docker run --env-file .env -p 3000:3000 leyla`).
3. Exposer en HTTPS sur un domaine sans port (ex. `https://leyla.english4french.com/salesiq`).

## Branchement dans SalesIQ
Settings → Bot → Zobot → Ajouter → Plateformes tierces → **Webhook** → nom « Leyla », profil (photo `leyla-avatar.jpg`), marque English 4 French, puis URL du webhook : `https://<votre-domaine>/salesiq`. Activer « Secure your webhook » et coller la clé publique dans `SIQ_PUBLIC_KEY`.

## Test de niveau adaptatif dans le chat (`placement/`)
Quand le visiteur clique « Faire le test de niveau » (ou écrit « tester mon niveau »), Leyla passe la main au moteur du dossier `placement/` : aucun appel au modèle, chaque réponse est calculée en quelques millisecondes.
- Déroulé : prénom + nom, e-mail, téléphone, lieu de formation (3 boutons, puis « Autre centre »), puis 18 à 22 questions (3 réponses en boutons + « Je ne sais pas » ; « stop » interrompt), puis le niveau (A1 à C1) avec un **score sur 100** (position dans le niveau, comparable d'un passage à l'autre : A1 < 25, A2 25–40, B1 40–55, B2 55–70, C1 ≥ 70), 3 points à améliorer, 3 parcours (niveau / entreprise / certification) avec leurs pages, et le lien de RDV (Lucile, ou Alexandra pour L'Isle-sur-la-Sorgue, via `BOOKING_URL` / `BOOKING_URL_ISLE`).
- Banque : `placement/items.json`, 74 questions du TDN90 calibrées sur 1 237 passages ; thèmes de la grille de correction E4F (« (QUESTIONS) Corrections TDN 90 E4F », colonnes F/G/H) et conseils dans `placement/skills.json` ; chaque question porte un thème principal `s` et ses thèmes `t` ; seuils, nombre de questions et pages des parcours dans `placement/engine.js` (`CONFIG`, `COURSES`).
- Après le test, le résultat est ajouté à l'historique de la conversation : Leyla continue en connaissant le niveau et les coordonnées.
- `TEST_WEBHOOK_URL` (optionnel) : reçoit en POST un JSON `{First_Name, Last_Name, Email, Phone, TDNA_Date, TDNA_Niveau, TDNA_Score, TDNA_3_points_am_liorer, Description, site, theta, answers, page}` à brancher sur Zoho Flow ou une fonction CRM pour créer/mettre à jour le prospect (champs `TDNA_*` existants dans le module Prospects). Sans cette variable, le résultat est seulement journalisé.
- Tests : `npm run test:placement` (sans clé API ni serveur).

## Mise à jour du contenu
Modifier les fichiers `knowledge/*.txt` (mêmes textes que vos 7 documents) ou `prompt.md`, puis redémarrer.

## Test local
`ANTHROPIC_API_KEY=... npm start` puis `npm test` dans un autre terminal (simule une conversation complète et mesure les temps de réponse). `npm run test:placement` vérifie le test de niveau seul.
