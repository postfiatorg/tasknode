from .base import BaseModel
from ..database import Base, engine
from .postfiat_tx import PostfiatTxCache
from .discord import FoundationDiscord
from .memo_detail import MemoDetailView

def init_db():
    Base.metadata.create_all(bind=engine)
