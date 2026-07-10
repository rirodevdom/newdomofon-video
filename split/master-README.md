# NewDomofon Video Master

Центральный управляющий сервер NewDomofon Video.

## Назначение

Master отвечает за:

- пользователей, роли и RBAC;
- устройства и камеры;
- регистрацию и управление video node;
- назначение камер нодам;
- центральные события и аудит;
- выпуск playback URL и короткоживущих media token;
- административный и пользовательский веб-интерфейс.

Master не записывает архив камер, назначенных удаленным нодам, и не обращается напрямую к локальным дискам или базам node.

## Состав

```text
backend/                  API, PostgreSQL, auth, RBAC, cameras, nodes
frontend/                 Vue/Vuetify web portal
public-events-proxy/      public events compatibility
media-public-proxy/       public media compatibility
smartyard-compat-proxy/   SmartYard compatibility
archive-policy-api/       archive policy helper
contracts/                versioned master/node API contracts
deploy/                   deployment examples
scripts/                  install, deploy and diagnostics
```

## Взаимодействие с node

Единственный обязательный интерфейс между проектами описан в:

```text
contracts/node-agent-api-v1.md
```

Изменение контракта сначала документируется и реализуется обратно совместимо на master, после чего обновляется node.

## Быстрое развертывание

```bash
sudo apt-get update
sudo apt-get install -y git unzip
sudo mkdir -p /opt/newdomofon-video-master
sudo chown -R "$USER:$USER" /opt/newdomofon-video-master

cd /opt/newdomofon-video-master
sudo bash scripts/install-debian12-prereqs.sh
sudo PROJECT_DIR=/opt/newdomofon-video-master bash scripts/deploy-master.sh
```

При первом запуске заполните `/etc/newdomofon-video/app.env`, затем повторите deploy.

## Обновление

Перед production-обновлением создавайте backup конфигурации, базы и текущего Git commit. Master обновляется раньше node только при обратно совместимых изменениях API.

## Runtime-данные

Не добавлять в Git:

- `/etc/newdomofon-video/app.env`;
- PostgreSQL dump;
- JWT, node registration token, agent token и media secret;
- production TLS keys и диагностические архивы с секретами.
