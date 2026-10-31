# Sakhi with automatic SOS SMS

## Run
```
node server.js
```
Needs Node 18 or newer. No npm install needed. Open http://localhost:3000

Without SMS keys the server runs in DRY RUN mode: the SMS text is printed in the terminal, nothing is sent.

## Send real SMS (Twilio)
```
export TWILIO_ACCOUNT_SID=ACxxxxxxxx
export TWILIO_AUTH_TOKEN=xxxxxxxx
export TWILIO_FROM=+1xxxxxxxxxx
export BASE_URL=https://your-domain.com
node server.js
```
- BASE_URL must be the public https address, because contacts open the tracking link from it.
- Phones need HTTPS (or localhost) to give location permission.
- If you host behind a proxy (Render, Railway, Nginx) also set TRUST_PROXY=1 so the rate limit sees real IPs.
- For India, SMS providers need sender registration (DLT). Check the provider's rules before launch.

## Use on a phone (location needs HTTPS)
Browsers block location on plain http:// addresses and on files opened directly. Open the app in one of these ways:
- On the same computer: http://localhost:3000 works.
- On a phone for testing: run a tunnel that gives an https link, for example `npx cloudflared tunnel --url http://localhost:3000` (or ngrok), set BASE_URL to that https link, restart the server, and open that link on the phone.
- For real use: host on Render, Railway or similar. They give https automatically.
Then tap Allow when the browser asks for location. If you tapped Block earlier, tap the lock icon next to the address bar and allow Location.

## How it works
1. Hold SOS for 2 seconds.
2. The page gets your location and calls POST /api/sos with your saved contacts.
3. The server creates a tracking link and texts every contact.
4. The page sends your position to POST /api/loc every few seconds.
5. Contacts open /t/<id> and see the map update.
6. "I'm safe. Stop sharing" calls POST /api/stop.

## Limits of this version
- Sessions are kept in memory. Restarting the server ends active tracking.
- Tracking updates only while the page stays open on the phone. A native app is needed for background tracking.
- SOS SMS is limited to 5 alerts per hour per IP.
