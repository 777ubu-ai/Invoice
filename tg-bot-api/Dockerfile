# Local Telegram Bot API Server.
# Поднимает форк официального tdlib/telegram-bot-api с лимитом загрузки
# 2 ГБ вместо 20 МБ у api.telegram.org. Бот направляется на этот сервер
# через переменную окружения TELEGRAM_API_ROOT.
#
# Готовый образ от aiogram — самый ходовой, обновляется регулярно.
FROM aiogram/telegram-bot-api:latest

# Railway будет подкидывать переменные окружения снаружи:
#   TELEGRAM_API_ID    — из https://my.telegram.org/apps
#   TELEGRAM_API_HASH  — оттуда же
#   TELEGRAM_LOCAL     — "1" чтобы разрешить файлы любого размера
#
# Параметры запуска передаём флагами CMD; entrypoint образа парсит env-vars
# и сам подставит --api-id / --api-hash, нам остаётся только включить
# --local mode и порт.

ENV TELEGRAM_LOCAL=1
EXPOSE 8081

# Health endpoint: HEAD http://host:8081/  → 404, что нормально для idle.
# Railway healthcheck выставлять не обязательно.
