# Breaker Billiards — Preferred Player Card (rewards app, upload copy)
Node 18+ app: server/ (API + static server), guest app (breaker_billiards_app.html), staff console (admin.html), card studio (card.html), scripts/, test/.
Full setup guide: README_APP.md (also APP_README.md, REWARDS.md).
Excluded on purpose: node_modules, .git, server/.env (+ backups), server/data/ and data-archive/ (live member DB), .secret, ADMIN_PASSWORD_FIRST_RUN.txt, printed card PDFs, scratch files.
## Upload
Create a PRIVATE GitHub repo and upload this folder's contents (the included .gitignore keeps secrets/data out). To run: `npm install && npm run setup && npm start`; copy server/.env.example to server/.env and fill it in on the host. The guest HTML alone can live on GitHub Pages; accounts/points need the Node server.
