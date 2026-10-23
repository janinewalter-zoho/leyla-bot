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

## Mise à jour du contenu
Modifier les fichiers `knowledge/*.txt` (mêmes textes que vos 7 documents) ou `prompt.md`, puis redémarrer.

## Test local
`ANTHROPIC_API_KEY=... npm start` puis `npm test` dans un autre terminal (simule une conversation complète et mesure les temps de réponse).
