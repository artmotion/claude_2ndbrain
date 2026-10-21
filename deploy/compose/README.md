# Self-host the 2ndBrain server with Docker Compose

One command, one machine you control, no vendor account.

```bash
cd deploy/compose
cp .env.example .env          # fill in POSTGRES_PASSWORD, JWT_SECRET, BETTER_AUTH_URL, ADMIN_PASSWORD
docker compose up -d --build
```

Then open `<BETTER_AUTH_URL>/admin`, sign in with `ADMIN_PASSWORD` and create
the accounts (there is no self sign-up). In the desktop or iPad app, sign in
with one of them and your `BETTER_AUTH_URL` as the server.

## What comes up

| Service | What it does |
| --- | --- |
| `postgres` | Postgres 17 (Debian), data in `data/db_volume` at the project root. Never published to the host. |
| `migrate` | Runs `dist/db/migrate.js` to completion, *then* exits. |
| `server` | Hono HTTP + Hocuspocus WS on **one** port (`3010`). |

The ordering is the point: `server` waits on `migrate` finishing successfully,
which waits on Postgres being healthy. A deploy can therefore never briefly
answer requests against an old schema.

**One port, not two.** The CRDT WebSocket is served on the HTTP port at `/sync`,
so there is nothing else to open or route. The dedicated `HOCUSPOCUS_PORT` exists
for local dev only.

## HTTPS — through a Cloudflare Tunnel

`server` binds to **127.0.0.1 by default**, on purpose: the API carries session
tokens and note content, and the apps only talk plain HTTP to `localhost`.
Expose it through a Cloudflare Tunnel, which terminates HTTPS at Cloudflare and
needs no open port on your router:

- **Inside this stack:** create the tunnel with the `cloudflared` CLI, put its
  `config.yml` (from `cloudflared/config.yml.example`, ingress →
  `http://server:3010`) and credentials JSON in `cloudflared/` (git-ignored),
  then run `docker compose --profile tunnel up -d`.
- **Elsewhere** (e.g. unraid's Cloudflared plugin): point the public hostname
  at `http://<host>:<PUBLIC_PORT>`; set `BIND_ADDR=0.0.0.0` only if cloudflared
  runs on another machine.

Either way `BETTER_AUTH_URL` is the tunnel's `https://` hostname. Details:
[`docs/DEPLOY.md`](../../docs/DEPLOY.md#reach-it-from-the-internet-cloudflare-tunnel).

## Accounts — the admin panel

`<BETTER_AUTH_URL>/admin`, protected by `ADMIN_PASSWORD` (min. 12 characters;
empty switches the panel off). List users, create them, set a new password,
disable / enable, delete, and add a user to a vault. Forgot the password?
`docker compose exec server printenv ADMIN_PASSWORD`.

## Operating it

```bash
docker compose logs -f server        # follow
docker compose ps                    # health
docker compose pull && docker compose up -d --build   # upgrade
```

**Back up `db_volume`.** It holds every note's CRDT history, accounts,
permissions and (unless you use MinIO) attachments — the server's copy of your
team's writing. The server container itself keeps nothing on disk; with the
`minio` profile, attachment bytes go to `data/data_volume`. Both live in the
project root's `data/` folder, which git ignores (change them with `DB_VOLUME` /
`DATA_VOLUME`), so
they survive restarts, rebuilds and `docker compose down -v`. The host port is
`PUBLIC_PORT` (default 3010). Note that each desktop client also keeps
its own `.md` files on disk, so a total server loss is recoverable from any
client's vault; the volume is what makes *new* devices and *late* teammates able
to catch up.

```bash
docker compose exec -T postgres pg_dump -U secondbrain secondbrain | gzip > secondbrain-$(date +%F).sql.gz
```

Deleting `db_volume` deletes the server's data; stop the stack before copying it.

## Optional pieces

- **Google sign-in** — set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` with the
  redirect URI `https://<your-server>/api/auth/callback/google`. It only signs in
  accounts you created in the admin panel (matched by email), never creates
  one. Unset, the apps hide the Google button.
- **No plans or limits.** Billing was removed from this fork: vaults, members,
  notes and storage are unlimited, and the Assistant and file sync are always on.
- **Multiple instances** — only then set `REDIS_URL`, so every instance shares
  the vault replication feed. A single server uses in-memory pub/sub and needs no
  Redis.

Full env var reference: [`docs/DEPLOY.md`](../../docs/DEPLOY.md).
