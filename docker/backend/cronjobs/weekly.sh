#!/bin/sh

cd "$PROJECT_ROOT" || exit 1
. "$VIRTUAL_ENV/bin/activate"

if [ -f "django.env" ]; then
  export $(grep -v '^#' django.env | xargs)
fi

# TODO

echo "DONE!"
