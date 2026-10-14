# Real-time flow from your Schwab account

The dashboard runs on CBOE's free feed, which is 15 minutes delayed. If you
have a Charles Schwab brokerage account, the dashboard can use Schwab's own
market-data API, which is real time and free to account holders, to make the
put/call **flow** real time for the busiest names.

What changes when connected:

- **Real time:** put/call volumes, P/C ratio, premium, net flow and spike
  alerts for a rotating hot set of about 200 names: your watchlist, the index
  benchmarks, anything flagged unusual, and the most active names. Each refreshes
  every one to two minutes. Those rows show a green dot next to the ticker, and
  the status pill reads **Real-time · N**.
- **Unchanged:** IV30, IV rank, skew, open interest, dealer gamma and
  everything the learning loop grades still come from CBOE for every name.
  Their history was built on CBOE's numbers, and Schwab computes IV
  differently, so mixing the two would move IV rank and the z-scores for
  reasons that have nothing to do with the market.
- **Everything else:** the other ~1,200 names stay on the delayed feed, as
  today.

If Schwab stops answering, or the weekly sign-in lapses, each row falls back
to the delayed feed within 10 minutes. Nothing goes blank.

## Before you start

Schwab licenses this data to you personally. The dashboard therefore refuses
to use it unless the site is password-locked (`SITE_PASSWORD`, below). A
Railway URL is otherwise reachable by anyone who has it.

## 1. Create a Schwab developer app (one time, takes a few days)

1. Go to **developer.schwab.com** and sign up. This is a separate developer
   login, not your brokerage login. If the portal asks you to request access to
   the Trader API for individuals, do so.
2. **Create an app**:
   - API product: **Market Data Production**. The dashboard only reads
     market data. It never touches balances, positions or orders.
   - Callback URL: `https://<your-railway-domain>/api/schwab/callback`.
     Find the domain under Railway → your service → Settings → Networking,
     e.g. `https://options-flow-production.up.railway.app/api/schwab/callback`.
     It must be HTTPS and match **exactly**: no trailing slash, same host.
     Changing it later sends the app back through Schwab's review, which
     takes days, so get it right the first time.
3. Wait for the app's status to read **Ready for use**. Schwab reviews new
   apps, usually within a few business days.
4. Open the app and copy its **App Key** and **Secret**.

## 2. Set the variables on Railway

Railway → your service → **Variables**:

| Variable | Value |
|---|---|
| `SITE_PASSWORD` | A long passphrase. Required: it locks the site. |
| `SCHWAB_APP_KEY` | The app's App Key. |
| `SCHWAB_APP_SECRET` | The app's Secret. |
| `SCHWAB_CALLBACK_URL` | Exactly the callback URL you registered. |

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_SECRET` | the site password | Signs the login cookie. If you set it, changing the password no longer signs browsers out. |
| `SCHWAB_RPM` | `100` | Chain requests per minute. Schwab allows 120. |
| `SCHWAB_HOT_SYMBOLS` | `200` | How many of the most active names rotate in real time. Your watchlist, benchmarks and spiking names come on top. |
| `SCHWAB_INTERVAL_SEC` | `20` | Length of one real-time pass. Leave it. |
| `SCHWAB_TOKEN_KEY` | the app secret | Secret the token-encryption key is derived from. Set it if you expect to rotate the app secret. |

Railway redeploys when variables change.

## 3. Connect

1. Open the site and enter the password.
2. Open **Data sources**: click the status pill in the top bar, or Settings →
   Data sources.
3. Click **Connect Schwab**, sign in with your **brokerage** login, and
   approve the access. Schwab asks which account(s) to share. Any one works,
   because only market data is read.
4. You land back on Data sources showing **Connected**. During market hours
   the first real-time rows appear within a couple of minutes, since each name
   needs two snapshots a minute apart before it has a real-time rate.

## Every week: reconnect

Schwab ends every sign-in **7 days** after you connect. Refreshing does not
extend it, and nothing in the API can. A day before it lapses a yellow banner
appears at the top of every page. Click **Reconnect** and sign in again; it
takes about 20 seconds. If you miss it, the dashboard quietly runs on the
delayed feed until you reconnect.

## How the tokens are kept

- Schwab's access token (30 minutes) and refresh token (7 days) are stored in
  the database **encrypted** with AES-256-GCM. The key is derived from your app
  secret, which lives only in Railway's variables. A copy of the database alone
  does not give access to your account.
- The access token is renewed automatically 5 minutes before it expires.
- **Disconnect** on the Data sources page deletes both tokens immediately.
- Tokens never reach the browser, the logs, or any API response.
- Without a database the tokens live in memory only, so every redeploy means
  connecting again.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| "Schwab did not accept the sign-in" | The app is not *Ready for use* yet, or `SCHWAB_CALLBACK_URL` does not match the registered callback character for character. |
| "Set SITE_PASSWORD first" | The site is not locked. Real-time stays off until it is. |
| "Schwab is sending DELAYED data" | Your account has not accepted the market-data agreements for real-time quotes. Accept them on schwab.com (non-professional use). |
| "N names Schwab could not return whole today" | Some chains are too large to come back in one response. Those names stay on the delayed feed for the day; the slot goes to the next name. |
| Banner: "sign-in expired" | The weekly sign-in lapsed. Reconnect. |

## Cost

The real-time loop roughly doubles the chain parsing the server does during
market hours (Railway meters CPU and memory; it does not meter inbound
traffic). It idles while the market is closed, like the delayed loop. To trim
it, lower `SCHWAB_HOT_SYMBOLS`.
