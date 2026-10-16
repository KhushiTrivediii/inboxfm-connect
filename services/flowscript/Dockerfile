FROM oven/bun:1.3.3-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN bun install --no-save

FROM oven/bun:1.3.3-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN bunx tsc -p tsconfig.json

FROM node:22-alpine AS run
ENV NODE_ENV=production
ENV FLOWSCRIPT_HOST=0.0.0.0
ENV FLOWSCRIPT_PORT=8081
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
USER node
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
