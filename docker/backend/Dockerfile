FROM progeomonitoring/detection-docker-setup:backend-base-py3.13.7-alpine3.21 AS python

ARG BACKEND_PORT
ARG DB_HOST
ARG DB_PORT
ARG DOCKER_UID=1000
ARG DOCKER_GID=1000
ARG DOCKER_SOCKET_GID=998

# DOCKER_SOCKET_GID is the host's docker group; it may already exist here under another
# name (e.g. 999 = ping) or equal DOCKER_GID, so join whichever group owns that gid.
# -H: the home folder (PROJECT_ROOT) is already created by WORKDIR in the base image.
RUN addgroup -g ${DOCKER_GID} -S progeo \
    && adduser -S -H -u ${DOCKER_UID} -G progeo -h ${PROJECT_ROOT} progeo \
    && socket_group="$(getent group ${DOCKER_SOCKET_GID} | cut -d: -f1)" \
    && if [ -z "${socket_group}" ]; then addgroup -g ${DOCKER_SOCKET_GID} -S docker && socket_group=docker; fi \
    && addgroup progeo "${socket_group}"

COPY ./requirements.txt ./requirements.txt
RUN pip install -r requirements.txt --use-feature=fast-deps

COPY ./docker/backend/ .
COPY ./progeo ./progeo
COPY ./manage.py ./manage.py
# pytest-django must see the root configuration before it imports test models;
# the shared conftest also supplies the test database setup and fixtures.
COPY ./setup.cfg ./conftest.py ./
COPY ./docker/cad_factory/cad_reader.py ./docker/cad_factory/cad_reader.py
# No .env / django.env in here - the images are public on Docker Hub. The
# container builds django.env at start from the host's files (start-supervisord.sh).

RUN sed -i -e 's/\r$//' ./*.sh
RUN chmod +x ./*.sh

RUN [ ! -z "$BACKEND_PORT" ]
RUN [ ! -z "$DB_HOST" ]
RUN [ ! -z "$DB_PORT" ]

ENV DOMAIN="${DB_HOST}:${DB_PORT}"
ENV PORT=${BACKEND_PORT}

RUN echo "# m h day mon day_of_week cmd" > /etc/crontabs/root
RUN echo "*/30 * * * * /bin/sh -c '${PROJECT_ROOT}/cronjobs/run_job.sh half-hour ${PROJECT_ROOT}/cronjobs/half-hour.sh >> /var/log/progeo/half-hour.log 2>&1'" >> /etc/crontabs/root
RUN echo "*/5 * * * * /bin/sh -c '${PROJECT_ROOT}/cronjobs/run_job.sh measure ${PROJECT_ROOT}/cronjobs/measure.sh >> /var/log/progeo/measure.log 2>&1'" >> /etc/crontabs/root
RUN echo "53 23 * * * /bin/sh -c '${PROJECT_ROOT}/cronjobs/run_job.sh daily ${PROJECT_ROOT}/cronjobs/daily.sh >> /var/log/progeo/daily.log 2>&1'" >> /etc/crontabs/root
RUN echo "53 23 * * 0 /bin/sh -c '${PROJECT_ROOT}/cronjobs/run_job.sh weekly ${PROJECT_ROOT}/cronjobs/weekly.sh >> /var/log/progeo/weekly.log 2>&1'" >> /etc/crontabs/root
# Staging server only (STAGING_AUTO_IMPORT=1), after live's nightly dumps (23:53) arrived
RUN echo "0 3 * * * /bin/sh -c '${PROJECT_ROOT}/cronjobs/run_job.sh staging-import ${PROJECT_ROOT}/cronjobs/staging-import.sh >> /var/log/progeo/staging-import.log 2>&1'" >> /etc/crontabs/root

RUN chmod 600 /etc/crontabs/root && chown root:root /etc/crontabs/root
RUN mkdir -p /var/spool/cron/crontabs && chown -R root:root /var/spool/cron
RUN touch /var/run/crond.pid && chown root:root /var/run/crond.pid
RUN test -x /usr/sbin/crond || chmod 755 /usr/sbin/crond
RUN mkdir -p /var/log/progeo /run && chown -R progeo:progeo /var/log/progeo

RUN sed -i -e 's/\r$//' ./scripts/*.sh
RUN sed -i -e 's/\r$//' ./**/*.sh
RUN sed -i -e 's/\r$//' ./cronjobs/*.sh
RUN chmod +x ./scripts/*.sh
RUN chmod +x ./cronjobs/*.sh
RUN chmod +x ./*.sh

RUN echo "alias dbbackup='python manage.py clear_token && python manage.py sync_default && python manage.py handle_all_dbs --command=dbbackup'" >> /etc/profile
RUN echo "alias dbrestore='python manage.py handle_all_dbs --command=dbrestore'" >> /etc/profile
RUN echo "alias venv='. $VENV_ROOT/bin/activate'" >> /etc/profile
# docker exec ... bash starts an interactive non-login shell, which reads
# ~/.bashrc rather than /etc/profile. Cover both root and the app user.
RUN for bashrc in /root/.bashrc "${PROJECT_ROOT}/.bashrc"; do \
        printf '\n[ -r /etc/profile ] && . /etc/profile\n' >> "$bashrc"; \
    done

RUN mkdir -p ${PROJECT_ROOT}/static && chown -R progeo:progeo ${PROJECT_ROOT}/static
RUN mkdir -p ${PROJECT_ROOT}/tmp && chown -R progeo:progeo ${PROJECT_ROOT}/tmp
RUN mkdir -p /var/log/progeo && chown -R progeo:progeo /var/log/progeo

CMD ["/bin/bash", "/home/progeo/detection-docker-setup/start-supervisord.sh"]