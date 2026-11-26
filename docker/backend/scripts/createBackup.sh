#!/bin/bash

cd "${PROJECT_ROOT}" || exit

printf "[BACKUP] Create Backups"
python manage.py handle_all_dbs --command=dbbackup

printf "[BACKUP] Notify Django"
python manage.py notify --created-backup=1
