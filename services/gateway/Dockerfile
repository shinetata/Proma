FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/

FROM oven/bun:1
WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/src/ src/
EXPOSE 3001 3002
CMD ["bun", "run", "src/index.ts"]
