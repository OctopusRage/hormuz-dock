# Node 24+ is required for the built-in node:sqlite module (used unflagged).
FROM node:24-alpine

# The app shells out to these: git (clone/pull), the docker CLI and the compose
# plugin (up/down/build/stats), and ssh for git-over-SSH remotes.
RUN apk add --no-cache git docker-cli docker-cli-compose openssh-client unzip

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=4100
EXPOSE 4100

CMD ["node", "server/index.js"]
