# Server

## Описание
Серверная часть на `Bun`: HTTP API, WebSocket‑сигнализация для WebRTC и управление присутствием. Хранение данных и авторизация — через Supabase. Для аватаров используется S3‑совместимое хранилище.

## Требования
- `bun`
- Supabase‑проект с настроенными таблицами и ключами
- S3‑совместимое хранилище для аватаров

## Запуск
```bash
cd server
bun install
bun run dev
```

Прод‑режим:
```bash
bun run start
```

## Переменные окружения
Обязательные для Supabase:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` — опционально (если не указан, используется `SUPABASE_SERVICE_ROLE_KEY`)

Хранилище аватаров:
- `SUPABASE_STORAGE_BUCKET`
- `SUPABASE_S3_ENDPOINT`
- `SUPABASE_S3_REGION` — по умолчанию `eu-central-1`
- `SUPABASE_S3_ACCESS_KEY_ID`
- `SUPABASE_S3_SECRET_ACCESS_KEY`

TURN/STUN (ICE‑серверы для WebRTC):
- `STUN_URLS` или `STUN_URL` — список через запятую
- `TURN_URLS` или `TURN_URL` — список через запятую
- `TURN_SECRET` — для временных учётных данных (HMAC)
- `TURN_USERNAME`, `TURN_CREDENTIAL` — статические учётные данные (если `TURN_SECRET` не задан)
- `TURN_TTL_SECONDS` — срок действия временных учётных данных (по умолчанию 600)
- `TURN_USER_PREFIX` — префикс имени пользователя для TURN

Сервер:
- `PORT` — порт HTTP сервера (по умолчанию `8080`)
- `TLS_ENABLED` — включить TLS (`true`)
- `TLS_CERT_PATH` — путь к сертификату (по умолчанию `certs/cert.pem`)
- `TLS_KEY_PATH` — путь к ключу (по умолчанию `certs/key.pem`)

## Эндпоинты
- WebSocket: `ws(s)://<host>:<port>/ws?token=<access_token>`
- HTTP API: `http(s)://<host>:<port>/api/...`

## Заметки
- Если `TLS_ENABLED=true`, но файлов сертификата нет, сервер стартует без TLS и логирует предупреждение.
- Для корректной работы WebRTC должны быть настроены STUN/TURN (иначе клиент получит ошибку конфигурации ICE).
