# WebCAVE: two images from one build.
#
#   docker build --target web     -t webcave-web     --build-arg BASE_PATH=/webcave/ .
#   docker build --target manager -t webcave-manager .
#
# "web" is nginx serving the built pages and public files under BASE_PATH and
# proxying <BASE_PATH>manager to the Manager; "manager" is the Node.js frame
# server. docker-compose.yml wires them together (see docs/deployment.md).

# ---- build: pages (Vite) and the bundled Manager (esbuild) ----------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --ignore-scripts
COPY . .
ARG BASE_PATH=/
ENV BASE_PATH=${BASE_PATH}
RUN npm run build && npm run build:manager

# ---- web: static pages behind nginx -----------------------------------------------------------
FROM nginx:1.27-alpine AS web
ARG BASE_PATH=/
ENV BASE_PATH=${BASE_PATH}
ENV MANAGER_UPSTREAM=manager:8765
COPY --from=build /app/dist /usr/share/nginx/html
# nginx's entrypoint renders /etc/nginx/templates/*.template with envsubst into conf.d/.
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80

# ---- manager: the frame server ---------------------------------------------------------------
FROM node:22-alpine AS manager
WORKDIR /app
COPY --from=build /app/dist-manager/server.mjs ./server.mjs
COPY configs ./configs
ENV WEBCAVE_CONFIGS_DIR=/app/configs
ENV WEBCAVE_PORT=8765
EXPOSE 8765
CMD ["node", "server.mjs"]
