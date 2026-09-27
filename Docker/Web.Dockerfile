FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json ./
COPY public ./public
COPY src ./src
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
ARG VITE_AUTH_WORKER_URL=""
ENV VITE_AUTH_WORKER_URL=$VITE_AUTH_WORKER_URL
RUN npm run build

FROM nginx:alpine
COPY Docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /app/web
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
