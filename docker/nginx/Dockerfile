FROM nginx:1.27.2-alpine

RUN apk update && apk add iproute2 iputils-ping
RUN apk upgrade

WORKDIR /etc/nginx/

COPY ./docker/nginx/conf.d /etc/nginx/conf.d
COPY ./docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY ./docker/nginx/fix_host_file.sh /docker-entrypoint.d/50-fix_hosts.sh
COPY ./docker/nginx/robots.txt /var/www/html/robots.txt

# Create new password
# sudo sh -c "echo -n 'red:' >> tmp/.htpasswd"
# sudo sh -c "openssl passwd -apr1 >> tmp/.htpasswd"
#COPY ./docker/nginx/.htpasswd /etc/nginx/.htpasswd

RUN sed -i -e 's/\r$//' /docker-entrypoint.d/50-fix_hosts.sh
RUN chmod +x /docker-entrypoint.d/50-fix_hosts.sh
