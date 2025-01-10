from logging.config import fileConfig
import os
from sqlalchemy import engine_from_config, pool
from alembic import context

config = context.config

logging_config = {
    'version': 1,
    'formatters': {
        'generic': {
            'format': '%(levelname)-5.5s [%(name)s] %(message)s',
            'datefmt': '%H:%M:%S',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'generic',
            'stream': 'ext://sys.stderr',
        },
    },
    'loggers': {
        'root': {
            'level': 'WARN',
            'handlers': ['console'],
            'qualname': '',
        },
        'sqlalchemy': {
            'level': 'WARN',
            'handlers': [],
            'qualname': 'sqlalchemy.engine',
        },
        'alembic': {
            'level': 'INFO',
            'handlers': [],
            'qualname': 'alembic',
        },
    },
}
fileConfig(config.config_file_name, logging_config)

section = config.config_ini_section
config.set_section_option(section, "sqlalchemy.url", 
    os.environ["DATABASE_URL"])

import sys
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
from tasknode.models import Base
target_metadata = Base.metadata

def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()

def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    configuration = config.get_section(config.config_ini_section)
    db_url = os.environ["DATABASE_URL"]
    configuration["sqlalchemy.url"] = db_url
    db_schema = db_url.rsplit("/", 1)[-1]
    configuration["version_table_schema"] = db_schema
    configuration["default_schema"] = db_schema

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )

        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
