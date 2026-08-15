# Переезд бота на свой VPS

Ниже — путь от «пустой Ubuntu-сервер» до «бот работает и данные из Supabase перенесены». Занимает **1–2 часа** если всё идёт по плану.

Стек на VPS: **Postgres 16** + **PostgREST** (совместим с supabase-js, чтобы код бота не переписывать) + **бот на Node 22**. Всё в Docker Compose. Автоперезапуск при падении и при ребуте VPS — встроен.

---

## 0. Требования к VPS

- **ОС**: Ubuntu 22.04 или 24.04 (Debian 12 тоже подойдёт)
- **RAM**: минимум 2 ГБ, комфортно 4 ГБ
- **Диск**: 20 ГБ (реально бот + Postgres съедят < 5 ГБ первое время)
- **Порты наружу**: только 22 (SSH). Всё остальное — внутри Docker-сети
- **Права**: root или sudo-пользователь

Если у тебя более экзотический дистрибутив (RockyLinux, Arch) — команды `apt` замени на `dnf`/`pacman`, всё остальное одинаково.

---

## 1. Ставим Docker

```bash
# Обновляем систему
sudo apt update && sudo apt upgrade -y

# Устанавливаем Docker + Compose plugin одной командой
curl -fsSL https://get.docker.com | sudo sh

# Разрешаем текущему пользователю управлять Docker без sudo
sudo usermod -aG docker $USER
# Перелогинься через SSH чтобы изменение применилось (или используй `newgrp docker`)

# Проверка
docker --version
docker compose version
```

---

## 2. Клонируем проект

```bash
# Логинишься в GitHub. Если репо публичная — просто клонируй.
# Если приватная — сгенерируй Personal Access Token на github.com/settings/tokens
# и вставь его в место пароля при клонировании.
cd /opt
sudo git clone https://github.com/777ubu-ai/Invoice.git tnved-bot
sudo chown -R $USER:$USER tnved-bot
cd tnved-bot
git checkout claude/telegram-bot-planning-zXqOn
```

---

## 3. Готовим переменные окружения

```bash
cp .env.example .env
nano .env  # или vim, что удобнее
```

Заполняешь:

| Переменная | Где взять |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather в Telegram → твой бот → API Token |
| `OWNER_TELEGRAM_ID` | @userinfobot в Telegram → скажет твой numeric id |
| `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` | my.telegram.org → Login → API development tools → создать App. Нужны для локального Bot API-сервера (файлы до 2 ГБ). |
| `ANTHROPIC_API_KEY` | console.anthropic.com/settings/keys → Create Key |
| `POSTGRES_PASSWORD` | сгенерируй: `openssl rand -base64 24` — вставь результат |
| `SUPABASE_JWT_SECRET` | сгенерируй: `openssl rand -base64 48` — вставь результат |
| `SUPABASE_SERVICE_ROLE_KEY` | сгенерируется на следующем шаге |

Пока `SUPABASE_SERVICE_ROLE_KEY` оставь пустым.

---

## 4. Генерируем service-role JWT

Скрипт читает `SUPABASE_JWT_SECRET` из `.env`, подписывает им 10-летний JWT.

```bash
./scripts/gen-service-role-jwt.sh
# Скопируй вывод в .env → SUPABASE_SERVICE_ROLE_KEY
```

Открой снова `.env`, вставь получившийся `eyJ...`, сохрани.

---

## 5. Запускаем стек

```bash
docker compose up -d
```

Что произойдёт:
1. Скачается Postgres 16 + PostgREST — ~200 МБ
2. Соберётся образ бота из твоего кода — ~1 мин
3. Postgres запустится, применит все `migrations/*.sql` автоматически
4. PostgREST подключится к Postgres
5. Бот дождётся Postgres и стартует

Смотрим логи бота:

```bash
docker compose logs -f bot
```

Ждём строчку типа `Bot @InvoiceAgentsBot started`. Если видишь ошибки подключения — переходи к разделу «Диагностика» внизу.

Проверь в Telegram: `/start` в бот → должно ответить меню.

---

## 6. Переносим данные из Supabase

Пока бот работает на **пустой** базе (нет твоих юзеров, инвойсов, precedents). Дампим Supabase и заливаем в локальный Postgres.

### 6.1. С Mac (или с сервера Supabase-CLI)

Сначала возьми connection string своей Supabase-базы:
`Dashboard → Project Settings → Database → Connection string → URI`. Выглядит как `postgres://postgres:PASSWORD@db.xxx.supabase.co:5432/postgres`.

С твоего Mac:

```bash
# Дамп только данных из public-схемы, миграции пропускаем (они уже применились)
brew install postgresql@16  # если ещё нет
pg_dump 'postgres://postgres:PASS@db.xxx.supabase.co:5432/postgres' \
  --data-only \
  --schema=public \
  --no-owner \
  --no-privileges \
  --file=supabase_dump.sql
```

### 6.2. Загружаем дамп на VPS

```bash
# С Mac копируем дамп на VPS
scp supabase_dump.sql user@YOUR_VPS_IP:/opt/tnved-bot/

# На VPS импортируем
cd /opt/tnved-bot
cat supabase_dump.sql | docker compose exec -T postgres psql -U tnved -d tnved
```

Проверь:

```bash
docker compose exec postgres psql -U tnved -d tnved -c '\dt'
docker compose exec postgres psql -U tnved -d tnved -c 'SELECT count(*) FROM telegram_users;'
docker compose exec postgres psql -U tnved -d tnved -c 'SELECT count(*) FROM invoices;'
```

Если счётчики совпадают с тем что в Supabase Dashboard — данные перенеслись.

---

## 7. Перезапуск бота после миграции данных

```bash
docker compose restart bot
docker compose logs -f bot
```

Проверь `/start` — теперь должно узнать тебя как OWNER, показать историю, всё как раньше.

---

## 8. Автостарт при ребуте VPS

Уже сделано. `restart: unless-stopped` в docker-compose означает: контейнер сам поднимется после `sudo reboot`.

Проверить можно:
```bash
sudo reboot
# ждёшь пока VPS вернётся, снова SSH
docker compose ps
# все три сервиса должны быть Up
```

---

## 9. Обновление кода

Когда я или ты пушнёте новый коммит в git:

```bash
cd /opt/tnved-bot
git pull
docker compose build bot
docker compose up -d bot
```

Postgres и PostgREST не трогаются — только бот пересобирается и перезапускается.

Если хочешь автоматизации через GitHub Actions — скажу, добавлю webhook.

---

## 10. Резервные копии Postgres

Каждую ночь дамп → в директорию:

```bash
# /etc/cron.d/tnved-bot-backup
0 3 * * * root cd /opt/tnved-bot && docker compose exec -T postgres pg_dump -U tnved tnved | gzip > /backup/tnved_$(date +\%Y\%m\%d).sql.gz
```

Хранить в облаке — можно rclone → S3/B2. Скажи, распишу.

---

## Диагностика

### Бот не отвечает / не запускается

```bash
docker compose logs bot | tail -50
```

Смотри последнее исключение. Часто это:
- `TELEGRAM_BOT_TOKEN` не заполнен → нет токена
- `ANTHROPIC_API_KEY` невалиден → 401 от Anthropic
- `SUPABASE_SERVICE_ROLE_KEY` не соответствует `SUPABASE_JWT_SECRET` → 401 от PostgREST (перегенерируй JWT)

### PostgREST не может подключиться к Postgres

```bash
docker compose logs postgrest | tail -20
```

Обычно причина — `POSTGRES_PASSWORD` изменили после первого запуска, а Postgres хранит старый пароль в volume. Или полностью пересоздай volume (`docker compose down -v` — **это удалит данные**), или зайди в psql и `ALTER USER tnved PASSWORD 'новый';`.

### Postgres не запускается: «database directory has wrong ownership»

Volume принадлежит другому пользователю. Обычно после смены имени тома. Пересоздай volume заново (`docker compose down -v && docker compose up -d`) — миграции применятся заново.

### «Function gen_random_uuid does not exist»

Postgres 16 требует `pgcrypto` или `uuid-ossp`. Открой `psql`:
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

---

## Что осталось на Railway после переезда

**Ничего**. После того как бот на VPS отвечает и данные перенесены — идёшь в Railway dashboard → удаляешь сервис Invoice. Экономия $5-10/мес.

Supabase проект тоже можно удалить, но сначала **убедись** что дамп у тебя лежит на VPS и на Mac. Лучше подождать неделю — если всё стабильно работает, тогда прощаемся с Supabase.
