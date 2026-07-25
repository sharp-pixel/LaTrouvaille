FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.mjs ./
COPY public ./public
COPY src ./src

ARG VITE_SEARCH_ENDPOINT=http://127.0.0.1:8790
ARG VITE_UBI_ENDPOINT=http://127.0.0.1:8787/ubi
ENV VITE_SEARCH_ENDPOINT=$VITE_SEARCH_ENDPOINT
ENV VITE_UBI_ENDPOINT=$VITE_UBI_ENDPOINT

RUN npm run build

FROM build AS api

COPY scripts ./scripts

ENV SEARCH_API_HOST=0.0.0.0
ENV SEARCH_API_PORT=8790

EXPOSE 8790

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8790/health || exit 1

CMD ["node", "scripts/search-api.mjs"]

FROM nginx:1.29-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1
