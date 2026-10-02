# Breaker Billiards — Menu, WiFi & Scoreboard (v2)

> This folder branches off commit `9d28fee` ("Design glow-up: retire the highlighter-yellow /
> SaaS-blue palette") in the parent repo. Everything below this line is byte-identical to that
> commit's `breaker_billiards_app.html` / `APP_README.md` at the moment of the branch — treat this
> `v2/` copy as the live working version going forward, and the parent folder's copies as the frozen
> snapshot of what shipped before the branch. Edit only the files in here from now on.

`breaker_billiards_app.html` is the whole app. One self-contained file — no build step, no server,
no dependencies. The logo, glassware photo, QR and app icons are embedded, so it works offline once
loaded.

It is a **web app**, deliberately. No App Store, no Play Store, no review process, no $99/year.
Guests add it to their Home Screen and it behaves like a native app.

---

## Put it live

**Hosted on GitHub Pages:** push this folder to a GitHub repo, then turn on Pages for it (repo →
Settings → Pages → Deploy from a branch). GitHub hands you a `https://<you>.github.io/<repo>/` URL —
text it, QR it, or point your own domain at it (repo → Settings → Pages → Custom domain).

GitHub Pages only serves plain files — there's no server behind it, no forms handler, nothing. That's
fine for the app itself (it's built to run with zero backend), but it does mean the WiFi/mailing-list
email capture needs somewhere to send addresses. That's already wired up and needs no setup — see
**Free WiFi + the email list** below.

**On your own domain instead (breakerbilliards.com/menu):**
1. Rename the file `index.html`.
2. Upload it to a `/menu` folder via your host's file manager.

### "Add to Home Screen"
- **iPhone:** Share button → Add to Home Screen
- **Android:** ⋮ menu → Add to Home Screen

Launches full screen with the proper Breaker icon, no browser chrome.

---

## What's in it

Five tabs across the bottom — **Drinks · Cocktails · Specials · Build · Score** — and a **☰ menu top
right** holding Favorites, Free WiFi, Can't Decide, Find Us, Merch, Call The Bar, Connect With Us, and
Share.

- **Social icons in the header** — a **Follow Us** cluster of Facebook, Instagram and TikTok sits
  next to the ☰ button on every page, so following is one tap from anywhere. They read their URLs
  from `"venue"` in the data block — change them in one place and every link in the app follows.
- **Live NOW / NEXT bar** — the second line of the header carries two live readouts: what is on
  **right now**, and what is **next**. It is opening-hours aware — see `"hours"` below.
- **Merch** — its own page (☰ menu → Merch), separate from Find Us, holding both the `"merch"` list
  (hoodies, tees, hats…) and the **Gift A Glass** glassware section with its photo. Both are edited
  the same way as everything else: name + price.
- **Connect With Us** — a popup (☰ menu → Connect With Us) with the logo, address, phone, website,
  Facebook/Instagram/TikTok, and a **Join The List** email signup. Reachable from every page. The same
  three social links also sit on the Find Us page, next to Call/Directions/Website.
- **Free WiFi gate** — guests give an email, the password appears. See the section below.
- **Magic 8 Ball** — "Can't decide?" A real 8 ball: shake it and the 20-sided die tumbles up through
  the liquid with your drink printed on its triangle. Narrow it by category or leave it on Surprise
  Me. It's the big card near the top of the Drinks tab, and it's also in the ☰ menu.
- **Live specials engine** — reads the device clock and shows what's on *right now*, what's next, and
  a countdown. Handles specials that run past midnight and rolls correctly across the week. Opening
  hours outrank specials: when the doors are shut the bar says **CLOSED** and the NEXT line switches
  to the opening time (plus whatever special is waiting on the other side of it), so the app never
  advertises a drink nobody can walk in and order.
- **Search across the whole menu** — 109 bottles, 8 drafts and the 9 signature cocktails, with the
  matched text highlighted.
- **Favorites that stick** — tap a heart on any bottle or cocktail. Saved on the device.
- **Old Fashioned builder** — pick a pour, smoker, syrup and bitters, then **Show the bartender** for a
  big order card. Only the smoker carries an upcharge; syrup and bitters are included.
- **Scoreboard** — pool and darts, 2 to 4 players, with a photorealistic table and dartboard. See below.
- **Rotating Taps** — its own section on the Drinks tab, right under Draft Beers, listing exactly
  what's pouring this week. Edit the six names in the data block whenever the taps turn over; no QR
  code, no scanning — the beers are just there.

Motion throughout: a break-shot intro that fades the logo in on first open, scroll reveals, ripples,
animated counters and a confetti celebration on a win. All of it disables under "Reduce Motion" and
pauses while backgrounded. The intro is wired to run before any other feature module, so even if
something later in the app fails to load, the first thing a guest sees is never a blank screen.

Overlays (menu, order card, 8 ball) lock the page behind them, close on Escape or a tap outside,
and keep keyboard focus inside while open. Tested down to a 320px phone and in landscape with no
horizontal scrolling anywhere.

**Everything is set in capitals**, app-wide, via a single `text-transform:uppercase` on `body`. The
one deliberate exception is the email input box — a typed address is left exactly as the guest typed
it, because visually shouting someone's own email back at them reads like a bug.

**The palette** is a muted antique-brass gold (`#D4AF37`) over a deep sapphire navy, not the
original bright highlighter-yellow and SaaS-blue pairing. Buttons and chips that go "on" use a
brushed-metal gradient (`--gold-hi` → `--gold` → `--gold-lo`) instead of a flat fill, so they read
as pressed brass rather than a flat sticker. Every color still passes WCAG AA with room to spare —
gold-on-navy runs around 9:1, well past the 4.5:1 minimum. Change any of the six tokens
(`--blue`, `--blue-lo`, `--blue-hi`, `--gold`, `--gold-hi`, `--gold-lo`) at the top of the
stylesheet to retune the whole app at once; nothing else needs touching.

---

## Free WiFi + the email list

**Read this part.** A web page cannot actually hold your network shut — that takes a captive portal
on the router itself (UniFi, Meraki, Omada and similar can do it). What this does is the **soft gate**
most bars run: it asks for an email, then shows the password. Someone determined can get around it.
In practice most guests just type their email, and you build a list.

It is built to **fail open** — if the form ever breaks, the guest still gets the password. Nobody is
left standing at the bar unable to get online.

### Point your QR codes at it

Your current table QR joins the network directly, which skips the email step. Regenerate it to point at:

```
https://your-url/#wifi
```

That opens the app straight onto the WiFi card. Once they're on the list they're also holding your
full menu — the WiFi code becomes the thing that installs the menu on every phone in the room.

### Where the emails go

Both this WiFi form **and** the "Join The List" signup on the Connect popup (☰ menu → Connect With
Us) feed into the same place — the `"mailingList"` block in the data section, a few lines below
`"wifi"`. One collector, two doors in.

### How the email capture works

**There is nothing to set up.** It's already pointed at
**breakerbilliardsemaillist@gmail.com**. A guest types their address, hits the button, and stays in
the app — no extra step for them, no account or dashboard for you.

Behind it is [FormSubmit](https://formsubmit.co), which is free, unlimited, and needs no signup. It
takes the address and emails it to that inbox, with the source (WiFi gate or Join The List) and a
timestamp. You build the list by hand from those emails, however you like.

**The one thing you must do — once:**

> After you deploy, do a test signup. FormSubmit will email
> breakerbilliardsemaillist@gmail.com a confirmation link. **Click it.** That activates the address.
> Until you do, nothing gets forwarded.

That's the whole setup. To send to a different address later, change `"notify"` in the `"mailingList"`
block — nothing else. To turn collection off entirely, blank out `"endpoint"`: guests still get the
WiFi password and the thank-you, nothing is captured, and the browser console says so.

Using a different service instead? Set `"endpoint"` to its form URL and `"notify"` to `""`. The posted
fields are `email`, `source` and `when`.

### Before you email anyone

You're collecting addresses to market to, so: only send what the consent line promises, put a real
unsubscribe link in every email, and honour it. That's CAN-SPAM, and it's also just how you avoid the
spam folder. The consent line is editable in the data block.

### Current settings

```json
"ssid": "Breaker Guest",
"password": "Breakers1142",
"gate": true
```

Change the password there whenever you rotate it. Set `"gate": false` to hand out the password with no
email ask, or `"enabled": false` to remove the WiFi card entirely.

---

## The scoreboard

**Getting into a game** is three quick screens: pick **Pool or Darts**, then pick the game, player
count and names, then **Start Scoring**. Keeping setup on its own screen is what leaves the felt table
and the dartboard visible without scrolling once play starts.

**Getting back out** is one tap: the **‹ Games** button sits at the top-left of the scoring screen,
opposite **Edit**. Games returns you to the Pool/Darts picker; Edit goes back to the game and player
setup for the game you're in. Neither one throws the game away — if there's a score on the board when
you come back, the app asks whether to **Continue This Game** or **Start New Game** (names are kept
either way).

**Rules** are on a link right under the game name while you play, and are also previewed on the setup
screen under the game chips so you can read them while deciding. The wording lives in the data block
under `"rules"` and is yours to edit to house rules.

**Players** — 2, 3 or 4, with editable names. Each gets a numbered billiard ball. Names and scores
survive closing the app.

### Pool — four games

| Game | Scoring | Target |
| --- | --- | --- |
| **8-Ball** | Racks won | Race to 3 / 5 / 7 / 9 |
| **9-Ball** | Racks won | Race to 3 / 5 / 7 / 9 |
| **Straight Pool** | Points, one per ball | 50 / 75 / 100 / 125 |
| **Cutthroat** | Balls left on the table | Last one standing (3 players) |

A felt table sits above the scores with six pockets, and **each player owns a corner pocket**. Winning
a rack sends a numbered ball flying across the cloth into their pocket. Their potted balls stack
beside it. Straight Pool runs to three figures, so it shows a progress bar and a running number
instead of a rack. Picking Cutthroat switches you to three players automatically, and its counter
runs *down* from five as your balls get sunk.

### Darts — three games

**501 / 301** — the classic countdown. Finish exactly on zero with a double. Below zero, or landing on
one, is a bust and the score snaps back. Suggested checkouts appear at 170 or under (141 →
`T20 · T19 · D12`). A **Keypad** toggle takes a whole turn as one number if that is faster.

**Cricket** — close 15 through 20 and the bull, three marks apiece. A treble closes a number outright,
a double gives two marks. Once you have closed a number and someone else has not, further hits score
its value. The grid shows every player's marks and points at a glance.

**Around the Clock** — 1 through 20 in order, then the bull. Three darts a turn, and you keep
advancing for every target you hit in the same turn.

All three are scored by **tapping the dartboard** where the dart landed — the trebles, doubles, outer
bull and bull are all live targets, and a dart flies in and sticks where you tapped. **Undo dart**
steps back through every throw, including across a leg win.

**The turn hands over on its own**, by each game's own rules: after three darts, immediately on a
bust, and immediately when a leg is won. You never press a "next player" button. When it changes, the
new thrower's ball and name flash up on screen for a moment and the phone gives a short buzz, so
whoever is up knows it without watching the screen.

## Editing the menu

All content is one readable, commented data block near the bottom of the file, starting with
`const D = {`. Save, re-upload, done.

- **New cocktail:** copy a line in `"cocktails"`, change name, price `p`, description `d`, tags `t`.
  Tags become filter buttons automatically, and feed the 8 ball's dropdown.
- **New bottle:** find the category in `"spirits"` or `"beer"` and add `["Bottle Name"]`, or
  `["Bottle Name","Variant one, Variant two"]`. Add `,1` for a PREMIUM badge: `["Blanton's","",1]`.
- **Price change:** edit the number. `13` shows as $13, `14.5` as $14.50.
- **Specials:** `"week"` drives the live banner. `from`/`to` are 24-hour times — `from:19` is a 7PM
  start, `to:26` runs to 2AM.
- **Draft list:** the `"Draft Beers"` category is the standard taps. `"Rotating Taps"`, right after it
  in the same `"beer"` array, is the separate weekly-rotation list — edit that one when the taps turn
  over. Both render the same way: their own heading, their own filter chip, hearts and search.

### Opening hours — `"hours"`

Now filled in: **Sunday–Thursday 12PM–2AM, Friday & Saturday 12PM–3AM.**

```json
"hours": [ [0,12,26], [1,12,26], [2,12,26], [3,12,26], [4,12,26], [5,12,27], [6,12,27] ]
```

Sunday is 0. Times are 24-hour, and a close past 24 means after midnight — `[5,12,27]` is Friday noon
until 3AM. Omit a day entirely if you're closed that day. Change a number here and the header's
NOW / NEXT bar, plus the Hours list on Find Us, both follow — nothing else to edit.

This drives the whole live readout:

| Situation | NOW | NEXT |
| --- | --- | --- |
| Before noon | `CLOSED` | `OPENS TODAY 12PM · HAPPY HOUR` |
| Open, special running | `OPEN · THIRST-DAY · ENDS IN 4H` | the following special |
| Open, nothing on | `OPEN · NO SPECIAL RUNNING` | `HAPPY HOUR · TODAY 1PM` |
| Last 90 minutes | `OPEN · …` | `LAST CALL · CLOSES 2AM` |

Three behaviours worth knowing:

- **The bar day ends at closing, not at midnight.** At 12:30AM on a Friday you are still working
  Thursday night, so the app still calls it Thursday: the Specials tab keeps the **Today** badge on
  Thursday, the Hours list keeps highlighting Thursday, and tomorrow's 1PM happy hour reads
  `TOMORROW 1PM`. The moment the doors shut at 2AM everything rolls over together and that same
  happy hour becomes `TODAY 1PM`. One helper (`businessDate`) drives every Today/Tomorrow label and
  every Today badge in the app, so they can never disagree with each other.
- **Specials belong to a trading day, not a calendar date.** Monday's all-day happy hour runs during
  *Monday's* session (noon to close), not from midnight — so it never leaks into the small hours at
  the end of Sunday night. Saturday and Sunday have no named special and no happy hour (happy hour is
  Mon–Fri, `"happyWindow"`), and the header correctly shows nothing running on those nights.
- **Specials are trimmed to opening hours.** An "all day" weekly special doesn't get advertised as
  starting at midnight on a day you open at noon — it's clipped to the hours you're actually open, so
  the countdown reads `ENDS IN 30M` at 1:30AM rather than a meaningless `ENDS IN 22H`.
- **Set `"hours"` back to `null`** and the app stops claiming open or closed entirely and talks about
  specials only. Wrong hours are worse than no hours — a guest who drives over on a bad OPEN reading
  is a worse outcome than one who was never told.

The Old Fashioned builder deliberately quotes **no total** — the pour sets the price and the bartender
rings it up. The only number it shows is the smoker's `+$1`, in `"upcharge"`.

### If the app goes blank after an edit

You broke the JSON, and it's almost always a missing or extra comma. Every entry needs a comma after
it except the last one in a list. Undo your change, or paste the block into jsonlint.com to find the
line. Deleting a whole section is safe — the app just renders that part empty — but a stray character
stops it loading.

---

## Do you need guest accounts for favorites?

**No.** Favorites already save to the device and survive closing the app. Adding Google/Apple/email
login means a backend, a privacy policy, a mandatory account-deletion flow, and Sign in with Apple
becoming compulsory on iOS the moment you offer Google. What you'd gain is favorites syncing between
someone's phone and tablet — rare for a bar menu.

If a customer list is the goal, **the WiFi gate already does that**, and people hand over an email far
more readily for wifi than for a login.

One caveat: in iPhone Safari, if someone doesn't open the menu for about a week, iOS may clear saved
favorites. Adding it to the Home Screen makes storage permanent.

---

## Notes

- Fonts load from Google Fonts. Offline, the app falls back to condensed system fonts and still looks
  right — just not pixel-identical.
- The file is ~660 KB, most of it the embedded logo and glassware photo. Fine on bar wifi, cached
  after the first visit.
- `native/` holds a Capacitor wrapper for iOS and Android, left over from when app stores were on the
  table. **It is parked and not needed.** Delete the folder if you want the tidier tree; if you ever
  change your mind, `cd native && npm install && npm run sync` picks the current web app back up.
- Ordering and payments are not built in — that means a cart, payment processing, POS integration and
  staff workflow, which is its own project. The Old Fashioned builder is the right skeleton for it.
