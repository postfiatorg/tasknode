import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.ext.declarative import declarative_base

DATABASE_URL = os.environ['DATABASE_URL']

# Engine configuration
engine = create_engine(
    DATABASE_URL,
    # Common configuration options:
    pool_size=5,                 # Maximum number of database connections in the pool
    max_overflow=10,            # Maximum number of connections that can be created beyond pool_size
    pool_timeout=30,            # Seconds to wait before giving up on getting a connection from the pool
    pool_recycle=1800,         # Recycle connections after 30 minutes
    echo=False                  # Set to True to log all SQL
)

# Session factory
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

# Base class for declarative models
Base = declarative_base()

# Session dependency (commonly used in FastAPI)
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
