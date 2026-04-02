FROM python:3.13.7-alpine3.21 AS python

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

RUN addgroup -S -g 1004 progeo && adduser -S -u 1003 -G progeo -h /home/progeo progeo
ENV PROJECT_ROOT=/usr/src/app
ENV VENV_ROOT=/opt/venv

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

RUN sed -i -e 's/\r$//' ./*.sh
RUN chmod +x ./*.sh

RUN [ ! -z "$BACKEND_PORT" ]
RUN [ ! -z "$DB_HOST" ]
RUN [ ! -z "$DB_PORT" ]

ENV DOMAIN="${DB_HOST}:${DB_PORT}"
ENV PORT=${BACKEND_PORT}

RUN echo "SHELL=/bin/sh" > /etc/crontabs/progeo
RUN echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" >> /etc/crontabs/progeo
RUN echo "# m h day mon day_of_week cmd" >> /etc/crontabs/progeo
RUN echo "53 23 * * * /usr/src/app/cronjobs/daily.sh" >> /etc/crontabs/progeo
RUN echo "53 23 * * 0 /usr/src/app/cronjobs/weekly.sh" >> /etc/crontabs/progeo
RUN chmod 600 /etc/crontabs/progeo && chown 1003:1004 /etc/crontabs/progeo
RUN mkdir -p /var/spool/cron/crontabs && chown -R 1003:1004 /var/spool/cron
RUN touch /var/run/crond.pid && chown 1003:1004 /var/run/crond.pid
RUN test -x /usr/sbin/crond || chmod 755 /usr/sbin/crond


RUN sed -i -e 's/\r$//' ./scripts/*.sh
RUN sed -i -e 's/\r$//' ./**/*.sh
RUN chmod +x ./scripts/*.sh
RUN chmod +x ./*.sh

RUN echo "alias dbbackup='python manage.py clear_token && python manage.py sync_default && python manage.py handle_all_dbs --command=dbbackup'" >> /etc/profile
RUN echo "alias dbrestore='python manage.py handle_all_dbs --command=dbrestore'" >> /etc/profile
RUN echo "alias venv='. $VENV_ROOT/bin/activate'" >> /etc/profile

RUN mkdir -p ${PROJECT_ROOT}/static && chown -R 1003:1004 ${PROJECT_ROOT}/static
RUN mkdir -p ${PROJECT_ROOT}/tmp && chown -R 1003:1004 ${PROJECT_ROOT}/tmp
RUN touch "${PROJECT_ROOT}/celery.log" && chown -R 1003:1004 "${PROJECT_ROOT}/celery.log"

CMD ./run-server.sh "${PORT}"
