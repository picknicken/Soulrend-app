# Soulrend server

Accounts, cloud saves, other players in your world, chat and the mod tools.

## Run it
```
cd server
npm install
MOD_PASS=choose-a-long-password node server.js      # listens on :8080 (PORT to change)
node test.js                                         # smoke test
```
Environment:
- `MOD_PASS`: password of the mod account. Without it the mod account does not exist.
- `MOD_NAME`: name of the mod account (default `Mod`).
- `PORT`, `DATA_DIR`: port and the folder for `accounts.json` (mount a volume here when hosting, or saves are lost on redeploy).

## Accounts
- Everyone makes their own account on the login screen (name plus password, stored as a scrypt hash).
- The mod account is created from `MOD_NAME` and `MOD_PASS` at start. It is always max level and has the **Mod** button.
- Your normal account stays a normal account. Log in with a different name to use the mod account.
- On the first account you can bring the progress that was saved on the device.

## Hosting on Railway (or any Node host)
1. New service from this repo, root directory `server`, start command `npm start`.
2. Variables: `MOD_PASS`, `DATA_DIR=/data`. Add a volume mounted at `/data`.
3. Generate a public domain. In the game, put `wss://your-domain` in the Server field.
4. Optional: build the app with a default server: `SOULREND_SERVER=wss://your-domain python3 tools/build_app.py`.

## What the server does and does not do
- It stores saves, relays positions (what friends see), chat and mod commands.
- Game rules still run in each client for now (friends-only trust). See `docs/multiplayer.md` for the path to a fully authoritative server.

## Mod commands (mod account only)
Spawn and remove items, give or remove XP and coins, set levels, max all skills, view inventory and chest, equipment and levels (live or from the last save), teleport to a player, bring a player, kick, announce.
