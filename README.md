# openclaw-max-plus – плагин MAX для OpenClaw

[![license](https://img.shields.io/github/license/MissiaL/openclaw-max-plus)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.15-green)](https://nodejs.org/)

Канал-плагин для подключения AI-ассистента [OpenClaw](https://openclaw.ai) к мессенджеру [MAX](https://max.ru) (max.ru Bot API).

> **English:** `openclaw-max-plus` is a channel plugin that connects the [OpenClaw](https://openclaw.ai) AI assistant to the [MAX messenger](https://max.ru) (max.ru Bot API). It brings Telegram-level parity to MAX: text & markdown, media (photo/video/file/sticker/contact/location, incl. inline base64), inline buttons, reply/forward/edit/delete, pin/unpin, response streaming, typing indicator, long polling **and** webhook, multi-account, and DM security. Written in TypeScript (ESM), requires Node.js ≥ 22.15. Full setup guide below is in Russian.

## Что это

Плагин позволяет общаться с OpenClaw-ботом через мессенджер MAX — так же, как через Telegram. Поддерживает:

- Приём и отправку текстовых сообщений (markdown)
- Вложения: фото, видео, файлы, стикеры, контакт, локация (в т.ч. inline-base64 — напр. сгенерированные картинки)
- Длинные подписи к медиа (>4000 — остаток уходит follow-up-сообщениями)
- Inline-кнопки: `callback` (+цвет intent), `link`, `request_contact`, `request_geo_location`, `message`, `clipboard`, `open_app`; выбор модели
- Reply, **forward** (приём с атрибуцией автора/канала), edit, delete
- **Pin/unpin** сообщений (admin-only, группы/каналы)
- Стриминг ответа (`streamMode`: partial / block), typing-индикатор
- Long polling и Webhook (с валидацией secret/url)
- Мультиаккаунт, DM-security, pairing, групповые политики

> Реакции и опросы MAX Bot API **не поддерживает** (платформенное ограничение). Нативные голосовые заметки MAX боту не доставляет (баг платформы).

## Структура проекта

```
openclaw-max-plus/
├── openclaw.plugin.json    # Манифест плагина
├── package.json
├── index.ts               # Точка входа плагина (register → channel)
├── tsconfig.json
├── README.md
├── src/
│   ├── types.ts            # TypeScript-типы MAX Bot API
│   ├── api.ts              # HTTP-клиент MAX API (send/edit/delete/upload/actions)
│   ├── monitor.ts          # Long polling + webhook (приём обновлений, dispatch)
│   ├── webhook.ts          # Обработчик webhook-запросов
│   ├── send.ts             # Высокоуровневые send-хелперы (текст/медиа/edit)
│   ├── channel.ts          # OpenClaw channel adapter
│   ├── config-schema.ts    # Zod-схема конфига канала
│   ├── accounts.ts         # Резолвинг аккаунтов из конфига
│   ├── runtime.ts          # Доступ к OpenClaw runtime
│   ├── actions.ts          # Действия/команды
│   ├── model-buttons.ts    # Кнопки выбора модели
│   ├── onboarding.ts       # Онбординг/настройка аккаунта
│   ├── format.ts           # Форматирование текста
│   └── sticker-cache.ts    # Кэш стикеров
└── scripts/
    ├── test-api.mjs        # Проверка токена и API (GET /me + GET /updates)
    └── test-send.mjs       # Тест send + edit + delete
```

## 🤖 Инструкция для агента: как настроить OpenClaw с этим плагином

Пошаговый runbook (выполнять по порядку, проверяя результат каждого шага).

**0. Предусловия**
- OpenClaw **2026.9.3 или новее**; версия 0.6.0 проверена с SDK 2026.9.3.
- Node.js **24.16+ (ветка 24)** или **26.1+**, согласно требованиям OpenClaw 2026.9.3. Для авто-доверия CA Минцифры используется `tls.setDefaultCACertificates`. Проверка: `node -e "const t=require('node:tls');console.log(typeof t.setDefaultCACertificates)"` → должно быть `function`.
- Установлен `openclaw` (CLI/gateway). Проверка: `openclaw --version`.
- Есть токен бота MAX (см. «Установка → Создать бота в MAX» ниже). Никогда не печатать токен в логи/коммиты.

**1. Собрать плагин** (entry — `dist/index.js`; build кладёт и `dist/certs/` с CA):
```bash
cd /путь/к/openclaw-max-plus
npm install
npm run typecheck && npm run lint && npm test   # должно быть зелёным
npm run build
```

**2. Подключить плагин к OpenClaw.** Способ А — через CLI:
```bash
openclaw plugins install --link /путь/к/openclaw-max-plus   # симлинк (live-разработка)
```
Способ Б — прописать путь в `~/.openclaw/openclaw.json` (gateway грузит из рабочей папки):
```jsonc
{ "plugins": { "entries": { "openclaw-max-plus": { "enabled": true } },
               "load": { "paths": ["/путь/к/openclaw-max-plus"] } } }
```

**3. Настроить канал** в `~/.openclaw/openclaw.json` (минимум — токен + кто может писать):
```jsonc
{ "channels": { "max": {
  "enabled": true,
  "botToken": "ТОКЕН_БОТА",       // или "tokenFile": "/path/to/token", или env MAX_BOT_TOKEN
  "dmPolicy": "allowlist",         // pairing | allowlist | open
  "allowFrom": ["ВАШ_USER_ID"],    // см. шаг 6, как узнать user_id
  "streamMode": "partial"
}}}
```
> Держать `src/config-schema.ts` ↔ `openclaw.plugin.json` в синхроне при добавлении полей.

**4. Индикатор «печатает…» — ОБЯЗАТЕЛЬНО задать глобально** (иначе индикатор будет мигать и обрываться, в MAX одиночный `typing_on` живёт ~5–6с):
```bash
openclaw config set agents.defaults.typingIntervalSeconds 4
```

**5. Перезапустить gateway** — зависит от того, как он запущен:
- launchd-сервис (`launchctl list | grep openclaw` показывает `ai.openclaw.gateway`): `launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"`
- вручную: остановить и `openclaw gateway --port 18789` (или `openclaw gateway restart`, если поддерживается).
> **После ЛЮБОЙ правки кода:** `npm run build` → перезапуск gateway (плагин держится в памяти, на лету не подхватывается).

**6. Проверить и найти свой user_id:**
```bash
openclaw plugins inspect openclaw-max-plus --runtime        # канал max зарегистрирован?
# Живой лог gateway (stdout). Путь зависит от запуска:
tail -f ~/Library/Logs/openclaw/gateway.log   # macOS launchd
# Написать боту в MAX любой текст → в логе появится "Starting MAX provider (@bot)" и обработка;
# user_id отправителя виден в логах или: MAX_BOT_TOKEN=xxx node scripts/test-api.mjs (раздел updates)
```
Подставить найденный `user_id` в `allowFrom` (шаг 3) и перезапустить gateway. Бот должен ответить.

**7. Диагностика «бот не отвечает»** (по приоритету):
1. `getUpdates`/TLS падает → проверь домен: `curl -I -H "Authorization: ТОКЕН" https://platform-api2.max.ru/me` (200/401 = TLS ок; `TLS:20`/`UNABLE_TO_GET_ISSUER` = нет CA → Node < 22.15 или `npm run build` не клал `certs/` → обнови Node и пересобери плагин с `certs/`).
2. Сообщение приходит, но ответа нет → смотри `~/.openclaw/agents/main/sessions/*.jsonl` (последние записи): дошёл ли inbound, не упал ли `toolResult` отправки (напр. `POST /messages → 404` = неверный chat_id; `ENAMETOOLONG` = inline-медиа; LLM-биллинг = квота).
3. `dmPolicy`/`allowFrom` блокируют отправителя → проверь user_id в `allowFrom`.

## Установка

### 1. Создать бота в MAX

1. Зайти на [business.max.ru](https://business.max.ru/self) (нужно юрлицо/ИП)
2. Создать профиль организации и пройти верификацию
3. Раздел **Чат-боты** → **Создать** (название, лого 500x500, описание)
4. Дождаться модерации (до 48ч по рабочим дням)
5. После модерации: **Чат-боты → Интеграция → Получить токен**

### 2. Собрать и подключить плагин

```bash
cd openclaw-max-plus
npm install
npm run build                          # собирает dist/ (entry: dist/index.js)

# Подключить плагин к OpenClaw из локальной папки
openclaw plugins install ./.           # или абсолютный путь к папке плагина
```

Альтернатива для разработки — указать путь к плагину прямо в конфиге
`~/.openclaw/openclaw.json`, тогда gateway грузит его из рабочей папки:

```jsonc
{
  "plugins": {
    "entries": { "openclaw-max-plus": { "enabled": true } },
    "load": { "paths": ["/путь/к/openclaw-max-plus"] }
  }
}
```

### 3. Настроить канал

Добавить секцию в `~/.openclaw/openclaw.json`:

```jsonc
{
  "channels": {
    "max": {
      "enabled": true,

      // Токен бота из business.max.ru → Чат-боты → Интеграция
      "botToken": "ваш_токен_бота",

      // Политика личных сообщений (по умолчанию "pairing"):
      //   "pairing"   — новый контакт проходит pairing-код
      //   "allowlist" — только user_id из allowFrom
      //   "open"      — любой (требует allowFrom: ["*"])
      "dmPolicy": "allowlist",

      // Список user_id, которым разрешено писать боту
      // Узнать свой user_id: написать боту и посмотреть в логах
      "allowFrom": ["12345678"],

      // Режим стриминга ответа: "off" | "partial" | "block"
      "streamMode": "partial"
    }
  }
}
```

### 4. Перезапустить gateway

```bash
openclaw gateway restart
```

> Можно проверить регистрацию канала: `openclaw plugins inspect openclaw-max-plus --runtime`.

## Индикатор «печатает…» (typing)

MAX гасит индикатор «печатает…» через несколько секунд, поэтому плагин
переотправляет его весь ход ответа через keepalive хоста. Частота
переотправки задаётся **глобальным** параметром `agents.defaults.typingIntervalSeconds`
(по умолчанию 6с). Одиночный `typing_on` в MAX живёт ~5–6с, поэтому значение по
умолчанию (6с) даёт разрывы. **Обязательно** выставьте **4** — иначе индикатор
будет мигать и обрываться:

```bash
openclaw config set agents.defaults.typingIntervalSeconds 4
openclaw gateway restart
```

> Параметр общий для всех каналов (затронет и Telegram — для него 4с тоже
> безопасно). Индикатор «печатает…» бота отображается **в мобильном клиенте
> MAX**; веб-версия его показывает ненадёжно — это особенность клиента MAX.

## Команды бота

Меню команд бота задаётся полем `commands` в конфиге канала и регистрируется в
MAX при старте провайдера (через `PATCH /me`). Каждая команда — `{ name,
description }` (`name` 1–64 симв., `description` до 128, максимум 32 команды):

```jsonc
{
  "channels": {
    "max": {
      "commands": [
        { "name": "status",  "description": "Статус и лимиты подписки" },
        { "name": "new",     "description": "Начать новую сессию" },
        { "name": "stop",    "description": "Прервать текущую задачу" },
        { "name": "restart", "description": "Перезапустить бота на сервере" }
      ]
    }
  }
}
```

После перезапуска gateway в логах будет `Registered N bot commands`, а команды
появятся в меню бота (мобильный клиент MAX). Проверить регистрацию на стороне
MAX: `GET /me` вернёт массив `commands`.

> Регистрация **меню** команд и их **обработка** — разные вещи. `name` команд —
> это встроенные slash-команды OpenClaw (`/status`, `/new`, `/stop`, …), которые
> обрабатывает ядро. Доставка ответов на команды через MAX-канал работает
> (проверено живьём).

## Настройка — основные поля канала

| Поле | Тип | Описание |
|------|-----|----------|
| `enabled` | boolean | Включить канал |
| `botToken` | string | API-токен бота (или `tokenFile` — путь к файлу с токеном) |
| `dmPolicy` | string | `pairing` (по умолч.) / `allowlist` / `open` |
| `allowFrom` | string[] | Разрешённые user_id (для `open` — `["*"]`) |
| `groupPolicy` | string | Политика групп, по умолч. `allowlist` |
| `groupAllowFrom` | string[] | Разрешённые user_id в группах |
| `groups` | object | Пер-групповые настройки (`requireMention`, `allowFrom`, `tools`, `skills`, …) |
| `streamMode` | string | `off` / `partial` / `block` |
| `webhookUrl` | string | URL webhook (если не используется long polling) |
| `webhookSecret` | string | Секрет для валидации webhook (рекомендуется в webhook-режиме) |
| `webhookPath` | string | Путь webhook-эндпоинта (по умолч. из `webhookUrl` или `/max`) |
| `responsePrefix` | string | Префикс к ответам бота |
| `mediaMaxMb` | number | Лимит размера медиа |
| `commands` | object[] | Меню команд бота (`{ name, description }`) — см. «Команды бота» |
| `accounts` | object | Дополнительные аккаунты (мультиаккаунт) |

Полный список — в [src/config-schema.ts](src/config-schema.ts).

## Использование

### Как написать боту

1. Найти бота в MAX по нику
2. Нажать **Старт** или отправить любое сообщение
3. Бот ответит, если ваш `user_id` разрешён политикой (`dmPolicy` / `allowFrom`)

### Как узнать свой user_id

Написать боту, затем посмотреть в логах OpenClaw:

```bash
openclaw logs --follow
# В логах будет sender.user_id входящего сообщения
```

Или запустить тест-скрипт:

```bash
MAX_BOT_TOKEN=xxx node scripts/test-api.mjs
# В разделе updates будет виден ваш user_id
```

## Мультиаккаунт

Можно подключить несколько ботов MAX — например, рабочий и личный:

```jsonc
{
  "channels": {
    "max": {
      // Аккаунт по умолчанию
      "botToken": "токен_основного_бота",
      "allowFrom": ["12345678"],

      // Дополнительные аккаунты
      "accounts": {
        "zaya": {
          "botToken": "токен_второго_бота",
          "allowFrom": ["87654321"],
          "dmPolicy": "open"
        }
      }
    }
  }
}
```

## Разработка

### Требования

- Node.js 20+ (встроенный fetch)
- TypeScript 6

### Команды

```bash
npm install
npm run build          # сборка dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (lint:fix — с автофиксом)
npm run format         # prettier --write (format:check — проверка)
npm test               # vitest (test:watch — watch-режим)
```

Перед коммитом: `npm run typecheck && npm run lint && npm test`.

### Тест API (проверка что токен работает)

```bash
# Проверить бота: GET /me + GET /updates
MAX_BOT_TOKEN=xxx node scripts/test-api.mjs

# С отправкой тестового сообщения в чат
MAX_BOT_TOKEN=xxx node scripts/test-api.mjs <chat_id>
```

### Тест отправки (send + edit + delete)

```bash
MAX_BOT_TOKEN=xxx node scripts/test-send.mjs <chat_id> "Текст сообщения"
```

## MAX Bot API — краткая справка

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/me` | Информация о боте (user_id, name, username) |
| PATCH | `/me` | Изменить бота (в т.ч. `commands` — меню команд) |
| GET | `/updates` | Long polling (marker, timeout, types) |
| POST | `/messages` | Отправить (`?chat_id` или `?user_id`) |
| PUT | `/messages` | Редактировать (`?message_id`) |
| DELETE | `/messages` | Удалить (`?message_id`) |
| POST | `/chats/{chatId}/actions` | Действия (`typing_on`, `mark_seen`, …) |
| POST | `/answers` | Ответ на callback (`?callback_id`) |
| POST · GET · DELETE | `/subscriptions` | Webhook: подписка / список / отписка |
| POST | `/uploads` | Загрузка медиа |

- Авторизация: заголовок `Authorization: <token>` (query-параметр `access_token` устарел).
- Документация: [dev.max.ru/docs-api](https://dev.max.ru/docs-api)
- ⚠️ `GET /chats` (список чатов) помечен устаревшим с июня 2026; одиночный `GET /chats/{chatId}` работает.
- ⚠️ Команды бота задаются через `PATCH /me` (поле `commands`); отдельного `POST /me/commands` в API нет.
- ✅ **Домен:** по умолчанию `platform-api2.max.ru` (legacy `platform-api.max.ru` отключается 19.07.2026). Этот домен подписан корневым CA Минцифры — плагин **бандлит CA и авто-доверяет ему в рамках процесса** (`certs/`, `src/ca-trust.ts`), **без установки сертификата в систему**. Требует Node ≥ 22.15. Откат/override: `apiBaseUrl` в конфиге канала или env `MAX_API_BASE_URL`.

## Лицензия

См. [LICENSE](LICENSE).
