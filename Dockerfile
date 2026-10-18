FROM node:26-slim
WORKDIR /app
RUN npm install -g pnpm@11.18.0
COPY . .
RUN pnpm install --frozen-lockfile --filter "@eyes/mcp..."
RUN pnpm --filter @eyes/web-dashboard build && pnpm --filter @eyes/mcp build
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
# The deployer writes .eyes-commit into the build context; it wins over the EYES_COMMIT env, which a Durable
# Object still on the previous Worker version passes with the previous value. exec keeps node as PID 1 (SIGTERM).
CMD ["sh", "-c", "[ -s .eyes-commit ] && export EYES_COMMIT=$(cat .eyes-commit); exec node --no-experimental-webstorage apps/mcp/src/main.ts"]
