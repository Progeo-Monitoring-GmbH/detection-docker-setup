FROM nginx:1.31.0-alpine

RUN apk update && apk add iproute2 iputils-ping
RUN apk upgrade
ARG MKCERT_VERSION=v1.4.4

RUN apk add --no-cache bash curl ca-certificates iproute2 iputils-ping nss-tools openssl && \
    update-ca-certificates && \
    ARCH="$(apk --print-arch)" && \
    case "${ARCH}" in \
      x86_64) MKCERT_ARCH="amd64" ;; \
      aarch64) MKCERT_ARCH="arm64" ;; \
      armv7) MKCERT_ARCH="arm" ;; \
      *) echo "Unsupported architecture: ${ARCH}" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-${MKCERT_ARCH}" -o /usr/local/bin/mkcert && \
    chmod +x /usr/local/bin/mkcert

WORKDIR /etc/nginx/

RUN mkdir -p /etc/letsencrypt && \
    [ ! -f /etc/letsencrypt/options-ssl-nginx.conf ] && \
    touch /etc/letsencrypt/options-ssl-nginx.conf
    
COPY ./docker/nginx/conf.d /etc/nginx/conf.d
COPY ./docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY ./docker/nginx/generate_mkcert.sh /docker-entrypoint.d/40-generate_mkcert.sh
COPY ./docker/nginx/fix_host_file.sh /docker-entrypoint.d/50-fix_hosts.sh
COPY ./docker/nginx/enable_local_cert.sh /docker-entrypoint.d/60-enable_local_cert.sh
COPY ./docker/nginx/robots.txt /var/www/html/robots.txt
COPY ./docker/nginx/ssl/rootCA.pem /etc/nginx/ssl/.mkcert

RUN sed -i -e 's/\r$//' /docker-entrypoint.d/*.sh
RUN chmod +x /docker-entrypoint.d/*.sh
