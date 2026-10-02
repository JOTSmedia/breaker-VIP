# Breaker Billiards — Preferred Player Card (rewards app)

A small, self-contained app that runs the Breaker Billiards loyalty program:

- **Customers** check their points, their tier, their "11th hour free" punch card and the rewards
  they can get, from their phone (card number + 4-digit PIN).
- **Staff** use the staff console (`admin.html`) to look up a card, sign someone up, add table
  hours and bar tabs, redeem free table time, fix mistakes, manage staff logins, and see every
  transaction.
- **Cards**: the printed cards BB0001–BB0050 are already in the system, and it can make
  print-ready PDFs for the next batch.

Everything runs from this one folder. There is no monthly service and no account to create.

---

## 1. Install Node.js (one time)

1. Go to **https://nodejs.org** and download the **LTS** installer (version 18 or newer).
2. Run it and accept the defaults.
3. To check it worked, open **Terminal** (Mac: press ⌘+Space, type "Terminal") and type:
   `node -v`. You should see something like `v22.x.x`.

## 2. Set it up (one time)

In Terminal, go into this folder and run two commands:

```bash
cd path/to/breaker_rewards      # tip: type "cd " then drag the folder onto the Terminal window
npm install
npm run setup
```

`npm run setup` will:

- create the settings file `server/.env`,
- ask you to choose an **admin password** (or press Enter and it makes a strong one for you and
  shows it once, so write it down),
- create the database with the 50 blank cards, BB0001–BB0050.

The password is stored only as a scrambled "hash", so nobody can read it back out of the file.

## 3. Run it

```bash
npm start
```

Or on a Mac, just **double-click `start.command`**. The first time, macOS may warn that it's from
an unidentified developer: right-click it, choose **Open**, then **Open** again. It installs and
sets up automatically if needed, then opens the staff console in your browser.

Once it's running:

| What | Address |
| --- | --- |
| Customer page (members check points) | http://127.0.0.1:4400/rewards |
| Staff console | http://127.0.0.1:4400/admin.html (first time: username `admin`) |
| Card studio | http://127.0.0.1:4400/card.html |

Leave the Terminal window open while the app is in use. Press **Ctrl+C** (or close the window)
to stop it. By default only the computer it's running on can open these pages (see Hosting below).

## 4. How the bar uses it (for staff)

Open the staff console (**http://127.0.0.1:4400/admin.html** on the bar computer) and sign in with
**your own** staff username and password. Front Desk logins see everything they need; a few
buttons (adjust points, change tier, close account, export, mint cards, Staff tab) only appear
for managers.

**Signing up a new member**
1. Tap **New Member**. The next blank card in the drawer is already picked. If you grabbed a
   different card, choose its number from the list.
2. Type their **name** and a **phone number or an email** (at least one; both is best).
   Birthday is optional.
3. Tap **Create Member**. A **4-digit PIN** appears once. Hand the card over and tell them the
   PIN (or let them pick one: type it in the PIN box before you tap Create).
4. They can now check their points at **/rewards** with the card number (or phone) + PIN.

**Adding points** (every visit)
1. **Front Desk** → type the card number, phone or email → **Look Up**.
2. Enter **table hours** and/or the **bar & food tab** (the amount before tax and tip, and never
   the table fee), and the **tip** in its own box if they left one. Never add the tip into the
   bar tab. The screen shows what it's worth.
3. Tap **Award Points**. 5 points per table hour, 1 point per $5 of bar tab and 1 point per $5
   tipped (bar and tip are each rounded down). Black tier gets 1.5×.
   Checks rung through Toast earn by themselves (bar on the subtotal, tip on the tip); don't
   add them again by hand.

**Redeeming free table time** (the only kind of reward)
- On the member's Front Desk screen, tap **Redeem** next to 1, 2 or 3 free hours
  (250 / 450 / 625 points). Points come off straight away.
- Or the guest shows you a **6-character code**, either from their phone app or printed on a
  receipt by the register. Type it into **Redeem A Code** (bottom of the Front Desk screen) and
  tap **Redeem Code**. Each code works once.
  - **The points were held when the code was made.** The big number on the member's screen is
    their **Available** points; underneath it says how many are **held** by open codes. Held
    points can't be spent on anything else. Redeeming the code takes the held points off; an
    expired code gives them back by itself.
  - App codes last **15 minutes** (one at a time: a new one replaces the old one); register codes
    last **24 hours**, and a member can have at most **2** open (set in `server/program.json`,
    `redeemCodes`).
  - Codes never use 0/O or 1/I/L, so there's nothing to mix up. Dashes and small letters are fine.
  - Every open code is listed under **Codes Waiting**, and on the member's own screen.
  - **Code for later** on the member's screen makes a code the guest can use another day (their
    points are held until then).
  - **Cancelling a code is for managers only.** If a code was made by mistake, ask a manager: they
    see a **Cancel** button (Front Desk logins don't), and cancelling gives the held points back.
  - Closing an account or replacing a lost card cancels that member's open codes (points
    released).

**Lost card**
- Look the member up → **Replace Lost Card** → type the number of a new blank card. Points,
  tier and history move to the new card; the old number is retired and can never be used again.
  Front Desk logins can do this; it's recorded with your name in the audit log.

**Fixing mistakes**
- Wrong name, phone or email: look them up → **Edit Details** → fix it → **Save**. Front Desk
  logins can do this. Every change is recorded with who made it (member record and audit log).
- Wrong points (rang in the wrong amount or the wrong person): ask a **manager**, who uses
  **Manual Adjustment** with a reason. Nothing is ever deleted; the mistake and the fix both stay
  on the record (Activity tab).
- Forgotten PIN: **Reset PIN**, and a new one is shown once.

**Staff logins**
- Everyone should have their own login, so the record shows who did what. A manager adds them on
  the **Staff** tab: username, name, role (Front Desk; the admin can also make Managers) and a
  password of 10+ characters. Give it to the person face to face.
- Someone leaves or a password gets out: **Switch Off** their login, or **Reset Password**. They
  are signed out everywhere immediately.
- The **admin** login is the owner's master key (set with `npm run set-password`). Don't use it
  for everyday work.

**Backups**
- Run `npm run backup` (e.g. at closing time) and copy the new file in `backups/` to a USB stick
  or cloud drive. See section 5.

**If the app is down**
- Keep serving. Write the card number, table hours, bar-tab subtotal and tip on a slip, and add the
  points when the app is back (use **Add Points** as normal).
- On the bar computer, double-click **start.command** (or run `npm start` in Terminal). If it
  says the port is in use, it's already running: open the staff console address above.
- If it still won't start, don't delete anything. Take a photo of the error and call whoever looks
  after the app. The member data is safe in `server/data/` and in your backups.

**Tips and service charges**
- A tip the guest chose earns 1 point per $5. An **automatic service charge / auto-gratuity**
  (e.g. on a large party) is **not** a tip and earns nothing. Toast checks handle this by
  themselves; at the Front Desk, only type a real tip into the Tip box.

**Tier set by a manager**
- A tier a manager sets by hand lasts **12 months**, then the member goes back to the tier their
  points earn. The end date shows next to "Set by manager" on their screen.

**Settings people ask about**
- The rules (points per hour, bar rate, tiers, rewards, code limits, how long a manager-set tier
  lasts) all live in `server/program.json`. Edit it and restart to change them.

### How the cards work

The printed cards carry **just a number** (`0001` … `0050`) on the back. There's no QR code or
barcode. In the system each card is `BB0001` … `BB0050`, and anyone can type the number any way
they like: `0001`, `1`, `BB0001` and `BB-0001` all mean the same card. Blank cards sit
"unassigned" until you sign someone up with one. If a card is lost, look the member up and use
**Replace Lost Card**: the points stay with the member and the old number is retired.

**Ordering more cards:**

1. Staff console → **Cards** → **Mint A Batch** (e.g. 50). This adds BB0051 onwards to the system.
2. Make the print file: `npm run cards -- --from 51 --count 50`. This writes
   `generated_cards/card_backs_BB0051-BB0100.pdf`, laid out exactly like the original backs.
   The front is the same on every card, so reuse `moo_card_fronts_BB0001-0050.pdf`.
3. The original `moo_card_*` PDFs are never changed.

## 5. Where your data lives, and backups

Everything (members, points, the transaction history, cards, staff logins) is in
**`server/data/`**: a few small `.json` files. Each save goes to a temporary file in that same
folder first and is then swapped in, so a crash or power cut can't leave a half-written file.

**Back up:**

```bash
npm run backup
```

This writes `backups/rewards-data-<date>_<time>.tar.gz` (the `backups/` folder is never committed
to git, and the file is readable only by you). Do it at least weekly, ideally nightly, and copy
the file off the computer (USB stick, iCloud Drive, Dropbox). It holds member details and the
session secret, so keep it private.

**Restore:**

1. Stop the app (Ctrl+C in its window).
2. `npm run restore -- backups/rewards-data-2026-09-29_230000.tar.gz`
3. Start the app again.

Restore refuses to run while the app is running, checks the file really is a rewards backup, and
first saves whatever is there now as `backups/pre-restore-….tar.gz`, so a restore can be undone.

Also keep a copy of `server/.env` somewhere private. It holds your settings. Never post it or
email it.

`server/data-archive/` holds old copies set aside during upgrades (e.g. the pre-launch demo
members). It's safe to keep, and you can delete it once you don't need it.

## 6. Changing the admin password

```bash
npm run set-password
```

Type the new one (or press Enter for a generated one), then restart the app. Anyone signed in to
the staff console with the old password is signed out.

**Staff logins:** create them in the staff console, **Staff** tab (see section 4). They are
stored as scrypt hashes in `server/data/staff.json`, never as plain text.

| Role | Can do |
| --- | --- |
| Front Desk (bar staff too) | look up and search members, sign up, add points, redeem free table time, redeem codes, make codes (Code for later), edit name/phone/email/birthday, reset a member PIN, replace a lost card (edits and card replacements go in the audit log) |
| Manager | all of that, plus **cancelling codes**, manual point adjustments, tier overrides (12 months), closing/reopening accounts, member CSV export, minting cards, clearing the POS log, managing Front Desk logins |
| Admin (the `.env` login) | everything, including managing Manager logins |

The older `.env` logins still work if you've set them: `MANAGER_PASS` (username `manager`),
`DESK_PASS` (`frontdesk`) and `BAR_PASS` (`barmanager` or `bar`, which signs in as a Front Desk
login; there is no separate bar role). They show on the Staff tab as "Set in server/.env" and can only be
changed in that file. Moving everyone to portal logins and blanking those lines is recommended.

## 7. Hosting options (so customers can use it from home)

The customer page has to talk to this app **while it's running**, because that's where the points
live. So it needs a computer or server that's always on. **Purely static hosting (GitHub Pages,
Linktree, Squarespace pages, etc.) can't store points** on its own.

| Option | Cost (roughly) | Good | Not so good |
| --- | --- | --- | --- |
| **A small always-on computer at the bar** (old Mac mini, or a Raspberry Pi 4/5 with a good SD card or SSD) | ~$0–$120 once | Data stays in the building; fast at the counter; no monthly bill | Only works inside the bar's network unless you add a tunnel (e.g. Cloudflare Tunnel or Tailscale Funnel) for customers at home; you look after backups and power |
| **Render / Railway / Fly.io** with a **persistent disk** | ~$5–$15/month | Always online, HTTPS included, customers can check points from anywhere | You **must** attach a persistent disk and set `DATA_DIR` to it, or points are wiped on every redeploy; free tiers usually sleep or have no disk |
| **A cheap VPS** (DigitalOcean, Hetzner, Linode…) | ~$4–$6/month | Full control, cheapest always-on option | Someone has to set up HTTPS (e.g. Caddy), updates and backups |

Whatever you choose:

- Set `HOST=0.0.0.0` (and `PORT` if your host tells you to) so it accepts outside connections.
  On hosts that have a settings dashboard, you can put `ADMIN_PASS`, `SESSION_SECRET` and
  `DATA_DIR` there instead of in a file.
- Always use **HTTPS** (the hosts above provide it). PINs and passwords shouldn't cross the
  internet unencrypted.
- Keep backing up the data folder.
- POS terminals (Toast / CueT) stay locked out until you set `POS_WEBHOOK_KEY` and give the same
  value to whoever configures the terminals (sent as an `X-POS-Key` header). Toast must send the
  pre-tax, pre-tip `subtotal` and the tip on its own (`tip`), and can ask for a redemption code
  (`POST /api/pos/redeem-code`) to print on a receipt (see REWARDS.md).
- Behind a **Cloudflare Tunnel**, set `TRUST_PROXY=cloudflare` so failed-login limits count each
  visitor's real address (from the `CF-Connecting-IP` header) instead of lumping everyone in as
  127.0.0.1. Only do this when the tunnel is the only way in (`HOST=127.0.0.1`).
- Settings already present in the real environment (e.g. systemd `Environment=`, a hosting
  dashboard) **win** over `server/.env`; the file never overrides them.
- The app sets **no cookies**. Staff and member sessions are signed tokens kept in the browser's
  local storage and sent in an `Authorization` header.

## 8. Putting the customer page on Linktree

Once the app is hosted at a public address (say `https://rewards.breakerbilliards.com`):

1. Sign in to Linktree and open **https://linktr.ee/breakerbilliards** in the editor.
2. Click **Add** → **Link**.
3. Title: **Preferred Player Card: check your points**. URL: your hosted address followed by
   `/rewards`, e.g. `https://rewards.breakerbilliards.com/rewards`.
4. Save, then drag it near the top.

`/rewards` opens the members' page directly (card number + PIN).

## 9. For the technically curious

- `npm test` runs the automated checks (card lookup, points, redeeming, restarts, logins, staff
  roles, member editing, tier overrides, lost cards, Toast subtotals, tips, redemption codes
  (including across a restart), backups, locked-down files,
  setup, card PDFs) against a throwaway copy of the data. It never touches `server/data`.
- Code: `server/server.js` (web server + API), `server/store.js` (database),
  `server/points.js` (points rules), `server/auth.js` (passwords, sessions),
  `scripts/setup.mjs`, `scripts/make-cards.mjs`, `scripts/backup.mjs`.
- Only one package is needed (`pdfkit`, for card PDFs). Everything else is built into Node.
- More background on the program design: `REWARDS.md`.
