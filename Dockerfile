FROM node:24-alpine

RUN apk add --no-cache postgresql-client

WORKDIR /app

COPY package.json .

RUN npm ci

COPY backup.mjs .

CMD ["node", "backup.mjs"]
