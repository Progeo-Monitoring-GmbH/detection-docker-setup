#!/bin/bash

IFS=';' read -ra ADDR <<< "${1}"
for db in "${ADDR[@]}"; do
  echo "CREATING DATABASE \"${db}\""
  echo "CREATE DATABASE \"${db}\"; GRANT ALL PRIVILEGES ON DATABASE \"${db}\" TO postgres;" > "/docker-entrypoint-initdb.d/${db}.sql"
done

echo "[DONE]"
