FROM node:24-alpine3.21 AS node

ARG FRONTEND_URL
ARG BACKEND_URL
ARG BACKEND_PORT

WORKDIR /home/progeo-frontend

COPY ./frontend/package.json .
COPY ./docker/frontend/.env.production ./.env

RUN sed -i -r "s|FRONTEND-TEMPLATE|${FRONTEND_URL}|g" ./.env
RUN sed -i -r "s|BACKEND-TEMPLATE|${BACKEND_URL}|g" ./.env
RUN sed -i -r "s|URL-TEMPLATE-WITH-PORT|${BACKEND_URL}:${BACKEND_PORT}|g" ./.env

RUN npm install

COPY ./frontend .
RUN npm audit fix --dry-run --json 2>&1 | tee npm-audit.log
ENV PATH=/home/progeo-frontend/node_modules/.bin:$PATH
#CMD ["tail", "-f", "/dev/null"]

RUN npm run build

# ##########################

FROM nginx:1.29-alpine

RUN rm /etc/nginx/conf.d/default.conf
RUN mkdir /usr/share/git/
RUN apk upgrade

## add permissions for nginx user
RUN chown -R nginx:root /var/cache/nginx && \
    chown -R nginx:root /var/log/nginx && \
    chown -R nginx:root /etc/nginx/conf.d
RUN touch /var/run/nginx.pid && chown -R nginx:root /var/run/nginx.pid

COPY --chown=nginx:root docker/frontend/default.conf /etc/nginx/conf.d/default.conf

WORKDIR /usr/share/nginx/html

USER nginx

COPY --from=node --chown=nginx:root /home/progeo-frontend/npm-audit.log /tmp/npm-audit.log
COPY --from=node --chown=nginx:root /home/progeo-frontend/dist /usr/share/nginx/html
COPY --chown=nginx:root ./docker/frontend/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
