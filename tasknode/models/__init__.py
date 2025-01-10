from ..database import Base, engine
from .postfiat_tx import PostfiatTxCache
from .discord import FoundationDiscord

def init_db():
    Base.metadata.create_all(bind=engine)
