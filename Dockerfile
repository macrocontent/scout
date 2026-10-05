FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.16.1 --activate
COPY package.json ./
RUN pnpm install
RUN npx playwright install-deps chromium && npx playwright install chromium
COPY . .
EXPOSE 3009
CMD ["pnpm", "run", "start"]
