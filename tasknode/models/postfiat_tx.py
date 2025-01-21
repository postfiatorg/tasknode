from sqlalchemy import Column, String, BigInteger, Text, Boolean, Index, text
from ..database import Base

class PostfiatTxCache(Base):
    __tablename__ = 'postfiat_tx_cache'

    hash = Column(String(255), primary_key=True)
    ledger_index = Column(BigInteger)
    close_time_iso = Column(String(255))
    meta = Column(Text)
    tx_json = Column(Text)
    validated = Column(Boolean)

    __table_args__ = (
        Index('idx_close_time_iso', text('close_time_iso DESC')),
    )
