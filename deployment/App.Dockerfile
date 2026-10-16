FROM public.ecr.aws/docker/library/node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --registry=https://registry.npmjs.org && npm run build
FROM public.ecr.aws/docker/library/node:24-slim
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/deployment/container-smoke.mjs ./deployment/container-smoke.mjs
USER 1000:1000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node","dist/server/index.js"]
