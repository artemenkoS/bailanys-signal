FROM oven/bun:1.1.8

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --production

COPY . .

EXPOSE 8080
ENV PORT=8080

CMD ["bun", "run", "index.ts"]
