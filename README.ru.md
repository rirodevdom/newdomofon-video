# NewDomofon Video

NewDomofon Video - bare-metal VMS/DVR-платформа для IP-камер. Проект работает на Debian 12 без Docker и включает управление камерами, пользователями и ролями, live HLS, локальный и устройственный архив, экспорт MP4, сбор ONVIF/Hikvision-событий и режим master/node для распределённых серверов записи.

Репозиторий является самостоятельной реализацией. В нём намеренно нет кода SesamePortal/Simple-DVR, зависимости от SesameDVR license-server и файла `LICENSE`.

## Что Умеет

- Управляет камерами, устройствами, video nodes, пользователями, ролями, избранным, аудитом и playback-токенами.
- Записывает потоки камер через FFmpeg в HLS-сегменты.
- Отдаёт live-плейлисты, архивные плейлисты, диапазоны архива, файлы и MP4-экспорт через подписанные media URL.
- Работает как на одном сервере, так и в распределённой схеме master/video-node.
- Собирает ONVIF- и Hikvision-события и сохраняет их в PostgreSQL.
- Поддерживает индексирование архива на стороне устройства, например Hikvision ISAPI.
- Даёт веб-портал на Vue/Vuetify с разделами dashboard, devices, cameras, nodes, player и administration.
- Содержит примеры nginx, systemd, nftables, SRS и скрипты деплоя под Debian 12.
- Включает компоненты совместимости для SmartYard, player-kit и публичных событий.

## Целевая Платформа

| Компонент | Технология |
| --- | --- |
| ОС | Debian 12 Bookworm |
| Runtime | Node.js 22, systemd |
| База данных | PostgreSQL |
| Веб-сервер | nginx |
| Backend | Express, TypeScript, PostgreSQL |
| DVR engine | Node.js, FFmpeg, HLS |
| Frontend | Vue 3, Vite, Vuetify, Pinia |
| Опциональный low-latency live | SRS bare-metal |

## Структура Репозитория

```txt
backend/                 Основной API, auth, RBAC, камеры, устройства, nodes, токены, миграции
dvr-engine/              FFmpeg recorders, live/archive HLS, exports, events, node agent
frontend/                Vue/Vuetify веб-портал и bundled player-kit assets
deploy/                  Примеры nginx, systemd, nftables, env и SRS
scripts/                 Скрипты установки, деплоя, ремонта и диагностики Debian 12
docs/                    API, security, Debian 12 и master/node документация
public-events-proxy/     Compatibility proxy для публичных событий
media-public-proxy/      Compatibility proxy для публичного media
smartyard-compat-proxy/  SmartYard compatibility service
dvr-archive-proxy/       Archive proxy и HLS discontinuity filtering helpers
restreamer/              Вспомогательный restream service
restream-gateway/        Restream gateway service
archive-policy-api/      Вспомогательный API политики архива
live-only-engine/        Вспомогательный live-only service
```

## Режимы Работы

### Один Сервер

Backend, frontend, PostgreSQL и DVR engine работают на одном хосте. DVR engine читает включённые камеры напрямую из PostgreSQL и пишет архив в `DVR_ROOT`.

Этот режим подходит для небольшого объекта, тестового стенда или миграции со старой standalone-установки.

### Master / Video Node

Master хранит пользователей, роли, устройства, камеры, токены, события и конфигурацию nodes. Video nodes подключаются к master по agent token, получают только назначенные камеры, пишут архив локально и отдают media через короткоживущие подписанные URL.

В этом режиме:

- master является единой точкой управления;
- nodes не нужен доступ к PostgreSQL;
- файлы архива хранятся на той node, за которой закреплена камера;
- браузер получает playback URL нужной node;
- доступ к media на node защищён HMAC media token.

Подробности: [`docs/MASTER_NODE.md`](docs/MASTER_NODE.md).

## Основные Сервисы

| Сервис | Порт по умолчанию | Назначение |
| --- | ---: | --- |
| `newdomofon-video-backend` | `3000` | Основной API и backend веб-приложения |
| `newdomofon-video-dvr` | `3010` | DVR engine, media API, recorder/node agent |
| nginx | `80/443` | Публичная точка входа для frontend, API и node media |
| PostgreSQL | `5432` | База данных master |
| SRS, опционально | зависит от конфига | Опциональные RTMP/WebRTC-сценарии |

## Быстрая Установка Master

Подготовь Debian 12 сервер и распакуй репозиторий в `/opt/newdomofon-video`.

```bash
sudo apt-get update
sudo apt-get install -y git unzip
sudo mkdir -p /opt/newdomofon-video
sudo chown -R "$USER:$USER" /opt/newdomofon-video

cd /opt/newdomofon-video
sudo bash scripts/install-debian12-prereqs.sh
sudo PROJECT_DIR=/opt/newdomofon-video bash scripts/deploy-master.sh
```

При первом запуске `deploy-master.sh` создаёт `/etc/newdomofon-video/app.env` из `deploy/env/master.env.example` и останавливается. Заполни секреты и запусти скрипт повторно.

Обязательные production-значения:

```txt
DATABASE_URL=postgres://newdomofon:CHANGE_DB_PASSWORD@127.0.0.1:5432/newdomofon_video
JWT_SECRET=CHANGE_TO_32_PLUS_RANDOM_CHARS
ADMIN_LOGIN=admin
ADMIN_PASSWORD=CHANGE_TO_STRONG_PASSWORD
CORS_ORIGIN=https://video-master.example.com
NODE_REGISTRATION_TOKEN=CHANGE_TO_RANDOM_NODE_REGISTRATION_TOKEN
INTERNAL_DVR_SECRET=CHANGE_TO_RANDOM_INTERNAL_SECRET
```

Затем запусти:

```bash
sudo PROJECT_DIR=/opt/newdomofon-video bash scripts/deploy-master.sh
```

Frontend разворачивается в:

```txt
/var/www/newdomofon-video
```

Открыть портал:

```txt
http://SERVER_IP/
```

Healthcheck backend:

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

Ожидаемый ответ:

```json
{"ok":true,"service":"backend"}
```

## Быстрая Установка Video Node

Создай node в UI master или зарегистрируй её через `/api/node-agent/register`. Master вернёт:

```txt
DVR_NODE_ID
DVR_NODE_TOKEN
DVR_NODE_MEDIA_SECRET
```

На node-сервере:

```bash
cd /opt/newdomofon-video
sudo bash scripts/install-debian12-prereqs.sh
sudo PROJECT_DIR=/opt/newdomofon-video bash scripts/deploy-node.sh
```

При первом запуске `deploy-node.sh` создаёт `/etc/newdomofon-video/app.env` из `deploy/env/node.env.example`. Заполни данные node:

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

Запусти деплой повторно:

```bash
sudo PROJECT_DIR=/opt/newdomofon-video bash scripts/deploy-node.sh
```

Healthcheck node:

```bash
curl -fsS http://127.0.0.1:3010/health
```

Ожидаемый ответ:

```json
{
  "ok": true,
  "service": "dvr-engine",
  "mode": "node",
  "node_id": "..."
}
```

## Разработка

Основные пакеты собираются независимо.

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

Команды сборки:

```bash
cd backend && npm run build
cd ../dvr-engine && npm run build
cd ../frontend && npm run build
```

Основным пакетам нужен Node.js `>=22.12.0`.

## Модель Камер И Архива

Devices описывают способ подключения камер. Поддерживаемые типы подключения:

```txt
RTSP
ONVIF
HIKVISION
```

Камера должна принадлежать устройству и может быть назначена на DVR node. Режим хранения архива:

```txt
node
device
both
```

- `node`: FFmpeg пишет архив на назначенной DVR node.
- `device`: архив читается со стороны камеры/NVR, например Hikvision ISAPI.
- `both`: доступны и node-side archive, и device-side archive.

Директория архива node по умолчанию:

```txt
/var/lib/newdomofon-video/dvr
```

Меняется через:

```txt
DVR_ROOT=/var/lib/newdomofon-video/dvr
```

После изменения настроек хранения:

```bash
sudo systemctl restart newdomofon-video-dvr
```

## Playback Flow

1. Frontend запрашивает `/api/player/:cameraId/live` или `/api/player/:cameraId/archive`.
2. Backend проверяет доступ пользователя к камере.
3. Backend находит назначенную DVR node.
4. Backend подписывает короткоживущий media token.
5. Браузер загружает media с node, например:

```txt
https://video-node-1.example.com/cameras/cam_001/live.m3u8?token=...
```

DVR engine проверяет scope токена, stream name и срок действия. URL сегментов в playlist переписываются так, чтобы token сохранялся при запросе сегментов и файлов.

## Обзор API

Аутентификация:

```txt
POST /api/auth/login
GET  /api/auth/me
```

Управление:

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

Media endpoints на DVR node:

```txt
GET /cameras/:streamName/live.m3u8?token=...
GET /cameras/:streamName/archive.m3u8?start=ISO&end=ISO&token=...
GET /cameras/:streamName/archive/ranges?start=ISO&end=ISO&token=...
GET /cameras/:streamName/device-archive.m3u8?start=ISO&end=ISO&token=...
GET /cameras/:streamName/device-archive/ranges?start=ISO&end=ISO&token=...
GET /cameras/:streamName/export.mp4?start=ISO&end=ISO&token=...
GET /files/:streamName/*?token=...
```

Подробнее: [`docs/API.md`](docs/API.md).

## Эксплуатация

Статус сервисов:

```bash
sudo systemctl status newdomofon-video-backend
sudo systemctl status newdomofon-video-dvr
```

Логи:

```bash
sudo journalctl -u newdomofon-video-backend -f
sudo journalctl -u newdomofon-video-dvr -f
```

Перезапуск:

```bash
sudo systemctl restart newdomofon-video-backend
sudo systemctl restart newdomofon-video-dvr
```

Проверка nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Production Notes

- Не открывай PostgreSQL в публичные сети.
- Используй HTTPS для всех публичных URL master и nodes.
- Держи `DVR_REQUIRE_MEDIA_TOKEN=true` на публичных nodes.
- Ротируй node tokens, если сервер node или env-файл могли быть скомпрометированы.
- Не коммить в git `JWT_SECRET`, `DVR_NODE_TOKEN`, `DVR_NODE_MEDIA_SECRET`, `INTERNAL_DVR_SECRET` и пароли базы данных.
- Используй отдельный диск или mount point для `DVR_ROOT` на recording nodes.
- Мониторь место на диске, FFmpeg-процессы, recorder status и archive retention.
- Ограничивай большие MP4 exports через `MAX_EXPORT_SECONDS`.
- В production systemd units сервисы должны работать от пользователя `newdomofon`.

Заметки по безопасности: [`docs/SECURITY.md`](docs/SECURITY.md).

## Полезная Документация

- [`docs/MASTER_NODE.md`](docs/MASTER_NODE.md) - деплой master/video-node и playback flow.
- [`docs/API.md`](docs/API.md) - обзор API endpoints.
- [`docs/BAREMETAL_DEBIAN12.md`](docs/BAREMETAL_DEBIAN12.md) - заметки по bare-metal деплою Debian 12.
- [`docs/DEBIAN12.md`](docs/DEBIAN12.md) - эксплуатационные заметки Debian 12.
- [`docs/SECURITY.md`](docs/SECURITY.md) - production security checklist.

## Текущие Ограничения

- Основной поддерживаемый путь playback - HLS. SRS/WebRTC подготовлен как опциональная инфраструктура, но требует отдельного UI/player-сценария.
- Очень большие MP4 exports генерируются DVR engine и для тяжёлой production-нагрузки должны быть вынесены в очередь.
- Логины и пароли камер/устройств хранятся в PostgreSQL. Для более строгого production лучше вынести секреты в Vault, Ansible SOPS или другой secret manager.
- Часть compatibility services и repair scripts привязана к конкретным деплоям. Перед включением на свежей установке их нужно проверить.
