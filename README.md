# openclaw-max – плагин MAX для OpenClaw

Канал-плагин для подключения AI-ассистента [OpenClaw](https://openclaw.ai) к мессенджеру [MAX](https://max.ru) (max.ru Bot API).

## Что это

Плагин позволяет общаться с OpenClaw-ботом через мессенджер MAX — так же, как через Telegram. Поддерживает:

- Приём и отправку текстовых сообщений
- Вложения (фото, видео, аудио, файлы)
- Inline-кнопки (callback / link) и выбор модели
- Форматирование (markdown / HTML)
- Стриминг ответа (`streamMode`: partial / block)
- Long polling и Webhook
- Мультиаккаунт
- DM-security, pairing, групповые политики

## Структура проекта

```
openclaw-max/
├── openclaw.plugin.json    # Манифест плагина
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts            # Точка входа плагина (register → channel)
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

## Установка

### 1. Создать бота в MAX

1. Зайти на [business.max.ru](https://business.max.ru/self) (нужно юрлицо/ИП)
2. Создать профиль организации и пройти верификацию
3. Раздел **Чат-боты** → **Создать** (название, лого 500x500, описание)
4. Дождаться модерации (до 48ч по рабочим дням)
5. После модерации: **Чат-боты → Интеграция → Получить токен**

### 2. Собрать и подключить плагин

```bash
cd openclaw-max
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
    "entries": { "openclaw-max": { "enabled": true } },
    "load": { "paths": ["/путь/к/openclaw-max"] }
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

> Можно проверить регистрацию канала: `openclaw plugins inspect max --runtime`.

## Индикатор «печатает…» (typing)

MAX гасит индикатор «печатает…» через несколько секунд, поэтому плагин
переотправляет его весь ход ответа через keepalive хоста. Частота
переотправки задаётся **глобальным** параметром `session.typingIntervalSeconds`
(по умолчанию 6с). Одиночный `typing_on` в MAX живёт ~5–6с, поэтому для
непрерывного индикатора рекомендуется значение **4**:

```bash
openclaw config set session.typingIntervalSeconds 4
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
> обрабатывает ядро. На момент написания доставка ответов на команды через
> MAX-канal в отладке (см. CLAUDE.md).

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
- ⚠️ **Миграция домена:** до **19.07.2026** перенести запросы с `platform-api.max.ru` на `platform-api2.max.ru` (+ сертификат Минцифры). В коде хост пока зашит — см. CLAUDE.md.

## Лицензия

См. [LICENSE](LICENSE).
