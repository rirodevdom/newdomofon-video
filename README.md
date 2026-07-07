# NewDomofon Video

NewDomofon Video - bare-metal VMS/DVR platform for IP cameras. The project runs on Debian 12 without Docker and provides camera management, users and roles, live HLS playback, local and device archive playback, MP4 export, ONVIF/Hikvision event collection, and a master/node mode for distributed recording servers.

The repository is a standalone implementation. It intentionally does not include SesamePortal/Simple-DVR code, a SesameDVR license-server dependency, or a `LICENSE` file.

## What It Does

- Manages cameras, devices, video nodes, users, roles, favorites, audit log, and playback tokens.
- Records camera streams with FFmpeg into HLS segments.
- Serves live playlists, archive playlists, archive coverage ranges, files, and MP4 exports through signed media URLs.
- Supports single-server operation and distributed master/video-node deployments.
- Collects ONVIF events and Hikvision events and stores them in PostgreSQL.
- Supports device-side archive indexing for Hikvision ISAPI archives.
- Provides a Vue/Vuetify web portal with dashboard, devices, cameras, nodes, player, and administration sections.
- Includes nginx, systemd, nftables, SRS, and Debian 12 deployment examples.
- Includes compatibility pieces for SmartYard/player-kit/public events integration.

## Target Platform

| Component | Technology |
| --- | --- |
| OS | Debian 12 Bookworm |
| Runtime | Node.js 22, systemd |
| Database | PostgreSQL |
| Web server | nginx |
| Backend | Express, TypeScript, PostgreSQL |
| DVR engine | Node.js, FFmpeg, HLS |
| Frontend | Vue 3, Vite, Vuetify, Pinia |
| Optional low-latency live | SRS bare-metal |

## Repository Layout

```txt
backend/                 Main API, auth, RBAC, cameras, devices, nodes, tokens, migrations
dvr-engine/              FFmpeg recorders, live/archive HLS, exports, events, node agent
frontend/                Vue/Vuetify web portal and bundled player-kit assets
deploy/                  nginx, systemd, nftables, env and SRS examples
scripts/                 Debian 12 install/deploy/repair/diagnostic scripts
docs/                    API, security, Debian 12 and master/node documentation
public-events-proxy/     Public events compatibility proxy
media-public-proxy/      Public media compatibility proxy
smartyard-compat-proxy/  SmartYard compatibility service
dvr-archive-proxy/       Archive proxy and HLS discontinuity filtering helpers
restreamer/              Restream helper service
restream-gateway/        Restream gateway service
archive-policy-api/      Archive policy helper API
live-only-engine/        Live-only helper service
```

## Runtime Modes

### Single Server

Backend, frontend, PostgreSQL, and DVR engine run on the same host. The DVR engine reads enabled cameras directly from PostgreSQL and records archive under `DVR_ROOT`.

Use this mode for a small installation, testing, or migration from an older standalone deployment.

### Master / Video Node

The master stores users, roles, devices, cameras, tokens, events, and node configuration. Video nodes connect to the master with an agent token, receive only assigned cameras, record locally, and serve media through short-lived signed URLs.

In this mode:

- master is the only management point;
- nodes do not need PostgreSQL access;
- archive files are stored on the node that owns the camera;
- the browser receives playback URLs pointing to the correct node;
- node media access is protected by HMAC media tokens.

Detailed deployment notes: [`docs/MASTER_NODE.md`](docs/MASTER_NODE.md).

## Main Services

| Service | Default port | Purpose |
| --- | ---: | --- |
| `newdomofon-video-backend` | `3000` | Main API and web application backend |
| `newdomofon-video-dvr` | `3010` | DVR engine, media API, recorder/node agent |
| nginx | `80/443` | Public entry point for frontend, API, and node media |
| PostgreSQL | `5432` | Master database |
| SRS, optional | config-dependent | Optional RTMP/WebRTC scenarios |

## Quick Master Install

Prepare a Debian 12 host and unpack the repository into `/opt/newdomofon-video`.

```bash
sudo apt-get update
sudo apt-get install -y git unzip
sudo mkdir -p /opt/newdomofon-video
sudo chown -R "$USER:$USER" /opt/newdomofon-video

cd /opt/newdomofon-video
sudo bash scripts/install-debian12-prereqs.sh
sudo PROJECT_DIR=/opt/newdomofon-video bash scripts/deploy-master.sh
```

On the first run `deploy-master.sh` creates `/etc/newdomofon-video/app.env` from `deploy/env/master.env.example` and stops. Edit the secrets and run it again.

Required production values:

```txt
DATABASE_URL=postgres://newdomofon:CHANGE_DB_PASSWORD@127.0.0.1:5432/newdomofon_video
JWT_SECRET=CHANGE_TO_32_PLUS_RANDOM_CHARS
ADMIN_LOGIN=admin
ADMIN_PASSWORD=CHANGE_TO_STRONG_PASSWORD
CORS_ORIGIN=https://video-master.example.com
NODE_REGISTRATION_TOKEN=CHANGE_TO_RANDOM_NODE_REGISTRATION_TOKEN
INTERNAL_DVR_SECRET=CHANGE_TO_RANDOM_INTERNAL_SECRET
```

Then run:

```bash
sudo PROJECT_DIR=/opt/newdomofon-video bash scripts/deploy-master.sh
```

The frontend is deployed to:

```txt
/var/www/newdomofon-video
```

Open:

```txt
http://SERVER_IP/
```

Backend healthcheck:

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

Expected response:

```json
{"ok":true,"service":"backend"}
```

## Quick Video Node Install

Create a node in the master UI or register it through `/api/node-agent/register`. The master returns:

```txt
DVR_NODE_ID
DVR_NODE_TOKEN
DVR_NODE_MEDIA_SECRET
```

On the node host:

```bash
cd /opt/newdomofon-video
sudo bash scripts/install-debian12-prereqs.sh
sudo PROJECT_DIR=/opt/newdomofon-video bash scripts/deploy-node.sh
```

On the first run `deploy-node.sh` creates `/etc/newdomofon-video/app.env` from `deploy/env/node.env.example`. Fill in the node credentials:

```txt
DVR_MASTER_URL=https://video-master.example.com
DVR_NODE_ID=PASTE_NODE_ID_FROM_MASTER
DVR_NODE_TOKEN=PASTE_AGENT_TOKEN_FROM_MASTER
DVR_NODE_PUBLIC_BASE_URL=https://video-node-1.example.com
DVR_NODE_MEDIA_SECRET=PASTE_MEDIA_SECRET_FROM_MASTER
DVR_REQUIRE_MEDIA_TOKEN=true
DVR_CORS_ORIGIN=https://video-master.example.com
BACKEND_INTERNAL_URL=https://video-master.example.com
INTERNAL_DVR_SECRET=CHANGE_TO_RANDOM_INTERNAL_SECRET
```

Deploy again:

```bash
sudo PROJECT_DIR=/opt/newdomofon-video bash scripts/deploy-node.sh
```

Node healthcheck:

```bash
curl -fsS http://127.0.0.1:3010/health
```

Expected response:

```json
{
  "ok": true,
  "service": "dvr-engine",
  "mode": "node",
  "node_id": "..."
}
```

## Development

Each main package is built independently.

Backend:

```bash
cd backend
npm ci
npm run migrate
npm run seed
npm run dev
```

DVR engine:

```bash
cd dvr-engine
npm ci
npm run dev
```

Frontend:

```bash
cd frontend
npm ci
npm run dev
```

Build commands:

```bash
cd backend && npm run build
cd ../dvr-engine && npm run build
cd ../frontend && npm run build
```

Node.js `>=22.12.0` is required by the main packages.

## Camera And Archive Model

Devices describe how cameras are connected. Supported connection types:

```txt
RTSP
ONVIF
HIKVISION
```

Cameras must belong to a device and can be assigned to a DVR node. Archive storage mode can be:

```txt
node
device
both
```

- `node`: FFmpeg records archive on the assigned DVR node.
- `device`: archive is read from the camera/NVR device side, for example Hikvision ISAPI.
- `both`: node-side archive and device-side archive are both available.

Default node archive directory:

```txt
/var/lib/newdomofon-video/dvr
```

Change it through:

```txt
DVR_ROOT=/var/lib/newdomofon-video/dvr
```

After changing storage settings:

```bash
sudo systemctl restart newdomofon-video-dvr
```

## Playback Flow

1. The frontend requests `/api/player/:cameraId/live` or `/api/player/:cameraId/archive`.
2. The backend checks the user's access to the camera.
3. The backend finds the assigned DVR node.
4. The backend signs a short-lived media token.
5. The browser loads media from the node, for example:

```txt
https://video-node-1.example.com/cameras/cam_001/live.m3u8?token=...
```

The DVR engine validates token scope, stream name, and expiration. Playlist segment URLs are rewritten so the token is preserved on segment and file requests.

## API Overview

Authentication:

```txt
POST /api/auth/login
GET  /api/auth/me
```

Management:

```txt
GET/POST/PATCH/DELETE /api/users
GET/POST/PATCH/DELETE /api/devices
GET/POST/PATCH/DELETE /api/cameras
GET/POST/PATCH/DELETE /api/dvr-servers
GET/POST/PATCH/DELETE /api/camera-groups
GET                 /api/dashboard
GET                 /api/audit
```

Playback:

```txt
GET /api/player/:cameraId/live
GET /api/player/:cameraId/archive?start=ISO&end=ISO
GET /api/player/:cameraId/export?start=ISO&end=ISO
GET /api/player/:cameraId/status
```

DVR node media endpoints:

```txt
GET /cameras/:streamName/live.m3u8?token=...
GET /cameras/:streamName/archive.m3u8?start=ISO&end=ISO&token=...
GET /cameras/:streamName/archive/ranges?start=ISO&end=ISO&token=...
GET /cameras/:streamName/device-archive.m3u8?start=ISO&end=ISO&token=...
GET /cameras/:streamName/device-archive/ranges?start=ISO&end=ISO&token=...
GET /cameras/:streamName/export.mp4?start=ISO&end=ISO&token=...
GET /files/:streamName/*?token=...
```

More details: [`docs/API.md`](docs/API.md).

## Operations

Service status:

```bash
sudo systemctl status newdomofon-video-backend
sudo systemctl status newdomofon-video-dvr
```

Logs:

```bash
sudo journalctl -u newdomofon-video-backend -f
sudo journalctl -u newdomofon-video-dvr -f
```

Restart:

```bash
sudo systemctl restart newdomofon-video-backend
sudo systemctl restart newdomofon-video-dvr
```

nginx check:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Production Notes

- Keep PostgreSQL private.
- Use HTTPS for every public master and node URL.
- Keep `DVR_REQUIRE_MEDIA_TOKEN=true` on public nodes.
- Rotate node tokens if a node server or env file is leaked.
- Keep `JWT_SECRET`, `DVR_NODE_TOKEN`, `DVR_NODE_MEDIA_SECRET`, `INTERNAL_DVR_SECRET`, and database passwords out of git and support archives.
- Use a dedicated disk or mount point for `DVR_ROOT` on recording nodes.
- Monitor disk usage, FFmpeg processes, recorder status, and archive retention.
- Limit large MP4 exports with `MAX_EXPORT_SECONDS`.
- For production systemd units, keep services running under the `newdomofon` user.

Security notes: [`docs/SECURITY.md`](docs/SECURITY.md).

## Useful Documentation

- [`docs/MASTER_NODE.md`](docs/MASTER_NODE.md) - master/video-node deployment and playback flow.
- [`docs/API.md`](docs/API.md) - API endpoint overview.
- [`docs/BAREMETAL_DEBIAN12.md`](docs/BAREMETAL_DEBIAN12.md) - Debian 12 bare-metal deployment notes.
- [`docs/DEBIAN12.md`](docs/DEBIAN12.md) - Debian 12 operating notes.
- [`docs/SECURITY.md`](docs/SECURITY.md) - production security checklist.

## Current Limitations

- HLS is the primary supported playback path. SRS/WebRTC is prepared as optional infrastructure but requires a separate UI/player scenario.
- Very large MP4 exports are generated by the DVR engine and should be moved to a queue for heavy production usage.
- Camera and device credentials are stored in PostgreSQL. For stricter production environments, move secrets into Vault, Ansible SOPS, or another secret manager.
- Some compatibility services and repair scripts are deployment-specific. Review them before enabling on a fresh installation.
