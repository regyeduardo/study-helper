from logging.config import fileConfig

from alembic import context
from sqlmodel import SQLModel

from app import config as app_config
from app.db import engine
from app.files import models as file_models  # noqa: F401
from app.folders import models as folder_models  # noqa: F401
from app.questions import models as question_models  # noqa: F401
from app.temp_files import models as temp_file_models  # noqa: F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", app_config.database_url())
target_metadata = SQLModel.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=app_config.database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
