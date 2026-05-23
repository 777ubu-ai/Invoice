# Local Telegram Bot API Server

Снимает лимит **20 МБ** на загрузку/скачивание файлов через бот. После
поднятия этого сервиса бот сможет принимать xlsx до **2 ГБ**.

## Что делать (один раз)

### 1. Получить API_ID и API_HASH

1. Открой https://my.telegram.org (войди по своему телефону, не бота)
2. Раздел **API development tools** → создай приложение (любые название/описание)
3. Скопируй два значения:
   - `api_id` (число, например `12345678`)
   - `api_hash` (строка из 32 символов)

⚠️ Это твои личные API-ключи, не делись ими и не коммить в репо.

### 2. Создать в Railway новый сервис

В проекте `empathetic-energy` (где уже крутится `Invoice`):

1. **+ New** → **Empty Service**
2. Назови `tg-bot-api`
3. **Settings** → **Source** → подключи репо `777ubu-ai/invoice`
4. **Settings** → **Build** → выбери `Dockerfile`
5. **Settings** → **Root Directory** → `tg-bot-api`
6. **Settings** → **Variables** → добавь:
   - `TELEGRAM_API_ID` = твой api_id
   - `TELEGRAM_API_HASH` = твой api_hash
7. **Settings** → **Networking** → **Private Networking** → **Enable**
8. Узнай внутренний URL — будет что-то вроде
   `tg-bot-api.railway.internal` (порт 8081 по умолчанию)
9. Deploy

### 3. Переключить бот на локальный сервер

В сервисе **Invoice** на Railway:

1. **Variables** → добавь
   - `TELEGRAM_API_ROOT` = `http://tg-bot-api.railway.internal:8081`
2. Redeploy сервис **Invoice**

### 4. Проверка

В Telegram пришли боту xlsx больше 20 МБ. Должен пройти классификацию
без ошибки «Файл больше 20 МБ».

В логах сервиса `Invoice` ищи строку:
```
"using local Telegram Bot API server"  apiRoot=http://tg-bot-api.railway.internal:8081
```

## Откат

Если что-то сломалось — просто удали переменную `TELEGRAM_API_ROOT` в
сервисе `Invoice` и redeploy. Бот вернётся на `api.telegram.org` (с лимитом
20 МБ обратно).
