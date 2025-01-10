#!/bin/bash
# TODO: replace with IaC
set -eux

PGHOST=${PGHOST:-localhost}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-postgres}
# assumes password is in discoverable .pgpass file

[ -z "${POSTGRES_PASSWORD:-}" ] && echo "Error: POSTGRES_PASSWORD environment variable must be set" && exit 1

psql -h $PGHOST -p $PGPORT -U $PGUSER -w <<EOF
CREATE DATABASE IF NOT EXISTS postfiat_db;
CREATE USER postfiat WITH PASSWORD '$POSTGRES_PASSWORD';
ALTER DATABASE postfiat_db OWNER TO postfiat;
EOF

psql -h $PGHOST -p $PGPORT -U $PGUSER -w -d postfiat_db <<EOF
CREATE SCHEMA IF NOT EXISTS public;
EOF
