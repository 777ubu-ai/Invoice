# Combined deployment: telegram-bot-api server + Node.js bot in one container,
# sharing the same filesystem so the bot can read large packing-list files
# directly from /var/lib/telegram-bot-api/<TOKEN>/documents/... without HTTP.

# Stage 1: build the Node.js bot.
FROM node:22-alpine AS bot-build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Stage 2: grab the pre-built telegram-bot-api binary from the aiogram image.
FROM aiogram/telegram-bot-api:latest AS tg-api

# Stage 3: runtime image. Alpine base + Node.js + telegram-bot-api binary.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# telegram-bot-api binary needs libstdc++ and libgcc on Alpine.
RUN apk add --no-cache libstdc++ libgcc bash

COPY --from=tg-api /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api
RUN chmod +x /usr/local/bin/telegram-bot-api

# Bot files.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=bot-build /app/dist ./dist
# Static data — ЕАЭС TN VED catalogue (≈5MB CSV). Bundled into the image so the
# bot can validate codes offline without depending on tnved.info/ifcg.ru.
COPY data ./data

# Data dir for telegram-bot-api files.
RUN mkdir -p /var/lib/telegram-bot-api /tmp/telegram-bot-api

# Combined entrypoint — runs both processes, forwards signals.
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

CMD ["/docker-entrypoint.sh"]
