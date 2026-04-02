#!/bin/sh

cd "$PROJECT_ROOT" || exit 1
. "$VIRTUAL_ENV/bin/activate"

python manage.py handle_all_dbs --command=dbbackup

echo "DONE!"
