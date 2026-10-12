# Plain Node.js image — no native/compiled dependencies in this app,
# so the same Dockerfile builds correctly for amd64, arm64 and armv7
# via `docker buildx build --platform ...` (see README).
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "server.js"]
