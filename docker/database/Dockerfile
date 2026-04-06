FROM postgres:17-alpine

ARG DJANGO_DATABASES

COPY ./docker/database/create_dbs.sh /opt/create_dbs.sh

RUN sed -i -e 's/\r$//' /opt/*.sh
RUN chmod +x /opt/*.sh
RUN chown postgres /opt/*.sh
RUN chown postgres -R /docker-entrypoint-initdb.d

USER postgres

RUN /opt/create_dbs.sh "${DJANGO_DATABASES}"
