#FROM postgis/postgis:17-3.5
FROM postgres:17-alpine

ARG DJANGO_DATABASES

#RUN apt-get update && apt-get install -y netcat-traditional

# Create a healthcheck.sh script
#RUN echo -e '#!/bin/sh\n\n# Check if PostgreSQL is healthy\npg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB} -h ${POSTGRES_HOST}' > /usr/local/bin/healthcheck.sh
#RUN chmod +x /usr/local/bin/healthcheck.sh
#CMD ["sh", "-c", "while true; do nc -l -p ${POSTGRES_PORT} -e /usr/local/bin/healthcheck.sh; done"]

COPY ./docker/database/create_dbs.sh /opt/create_dbs.sh

RUN sed -i -e 's/\r$//' /opt/*.sh
RUN chmod +x /opt/*.sh
RUN chown postgres /opt/*.sh
RUN chown postgres -R /docker-entrypoint-initdb.d

USER postgres

RUN /opt/create_dbs.sh "${DJANGO_DATABASES}"
