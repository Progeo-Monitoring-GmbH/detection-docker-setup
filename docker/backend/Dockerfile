FROM python:3.13.7-alpine3.21 AS python

ARG PROTOCOL
ARG FRONTEND_PORT
ARG BACKEND_PORT
ARG DB_HOST
ARG DB_PORT

RUN apk update && apk add --no-cache  \
                      ffmpeg \
                      nano \
                      iputils-ping \
                      lsb-release \
                      gnupg \
                      wget \
                      curl \
                      ca-certificates

RUN apk update && apk add git \
                      supervisor \
                      dcron \
                      rsync \
                      iputils-ping \
                      libpq-dev \
                      gcc

RUN apk add python3-dev musl-dev linux-headers make automake g++ bash postgresql-client
RUN apk add gdal \
            gdal-dev \
            geos \
            geos-dev \
            build-base
RUN apk add proj proj-dev

ENV PROJECT_ROOT=/usr/src/app
ENV VENV_ROOT=/opt/venv

RUN addgroup -S progeo && adduser -S -G progeo -h ${PROJECT_ROOT} progeo

WORKDIR ${PROJECT_ROOT}

RUN wget https://raw.githubusercontent.com/vishnubob/wait-for-it/master/wait-for-it.sh -O wait-for-it.sh

RUN python3 -m venv $VENV_ROOT
RUN python3 -m ensurepip --upgrade
RUN pip install -U setuptools pip

ENV PATH="$VENV_ROOT/bin:$PATH"
RUN . $VENV_ROOT/bin/activate

#Temp hotfix see https://github.com/pypa/setuptools/issues/4519
RUN pip install -U certifi setuptools pip
#RUN pip install opencv-python-headless==4.12.0.88 --use-feature=fast-deps

COPY ./requirements.txt ./requirements.txt
RUN pip install -r requirements.txt --use-feature=fast-deps

COPY ./docker/backend/ .
COPY ./progeo ./progeo
COPY ./manage.py ./manage.py
COPY ./.env ./django.env /tmp/
RUN cat /tmp/.env /tmp/django.env > ./django.env \
    && rm -rf /tmp/*

RUN sed -i -r "s|@PROTOCOL|$PROTOCOL|g" ./django.env
RUN sed -i -r "s|@FRONTEND_PORT|$FRONTEND_PORT|g" ./django.env
RUN sed -i -r "s|@BACKEND_PORT|$BACKEND_PORT|g" ./django.env

RUN sed -i -e 's/\r$//' ./*.sh
RUN chmod +x ./*.sh

RUN [ ! -z "$BACKEND_PORT" ]
RUN [ ! -z "$DB_HOST" ]
RUN [ ! -z "$DB_PORT" ]

ENV DOMAIN="${DB_HOST}:${DB_PORT}"
ENV PORT=${BACKEND_PORT}

RUN echo "# m h day mon day_of_week cmd" > /etc/crontabs/root
RUN echo "*/30 * * * * su progeo -s /bin/sh -c '/usr/src/app/cronjobs/half-hour.sh >> /var/log/progeo/half-hour.log 2>&1'" >> /etc/crontabs/root
RUN echo "*/1 * * * * su progeo -s /bin/sh -c '/usr/src/app/cronjobs/minute.sh >> /var/log/progeo/minute.log 2>&1'" >> /etc/crontabs/root
RUN echo "53 23 * * * su progeo -s /bin/sh -c '/usr/src/app/cronjobs/daily.sh >> /var/log/progeo/daily.log 2>&1'" >> /etc/crontabs/root
RUN echo "53 23 * * 0 su progeo -s /bin/sh -c '/usr/src/app/cronjobs/weekly.sh >> /var/log/progeo/weekly.log 2>&1'" >> /etc/crontabs/root
RUN chmod 600 /etc/crontabs/root && chown root:root /etc/crontabs/root
RUN mkdir -p /var/spool/cron/crontabs && chown -R root:root /var/spool/cron
RUN touch /var/run/crond.pid && chown root:root /var/run/crond.pid
RUN test -x /usr/sbin/crond || chmod 755 /usr/sbin/crond
RUN mkdir -p /var/log/progeo /run && chown -R progeo:progeo /var/log/progeo


RUN sed -i -e 's/\r$//' ./scripts/*.sh
RUN sed -i -e 's/\r$//' ./**/*.sh
RUN chmod +x ./scripts/*.sh
RUN chmod +x ./cronjobs/*.sh
RUN chmod +x ./*.sh

RUN echo "alias dbbackup='python manage.py clear_token && python manage.py sync_default && python manage.py handle_all_dbs --command=dbbackup'" >> /etc/profile
RUN echo "alias dbrestore='python manage.py handle_all_dbs --command=dbrestore'" >> /etc/profile
RUN echo "alias venv='. $VENV_ROOT/bin/activate'" >> /etc/profile

RUN mkdir -p ${PROJECT_ROOT}/static && chown -R progeo:progeo ${PROJECT_ROOT}/static
RUN mkdir -p ${PROJECT_ROOT}/tmp && chown -R progeo:progeo ${PROJECT_ROOT}/tmp
RUN mkdir -p /var/log/progeo

RUN touch "${PROJECT_ROOT}/celery.log" && chown -R progeo:progeo "${PROJECT_ROOT}/celery.log"
RUN touch /var/log/progeo/supervisord.log \
    /var/log/progeo/cron.log \
    /var/log/progeo/cron-supervisor.log \
    /var/log/progeo/cron-supervisor.err.log \
    /var/log/progeo/backend.log \
    /var/log/progeo/backend.err.log \
    /var/log/progeo/celery.log \
    /var/log/progeo/half-hour.log \
    /var/log/progeo/daily.log \
    /var/log/progeo/weekly.log \
    && chown -R progeo:progeo /var/log/progeo

CMD ["/usr/bin/supervisord", "-c", "/usr/src/app/supervisord.conf"]
