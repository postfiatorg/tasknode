from sqlalchemy import Column, String, BigInteger, Text, Boolean, Float, Index
from ..database import Base

class PostfiatTxCache(Base):
    __tablename__ = 'postfiat_tx_cache'

    hash = Column(String(255), primary_key=True)
    close_time_iso = Column(String(255))
    ledger_hash = Column(String(255))
    ledger_index = Column(BigInteger)
    meta = Column(Text)
    tx_json = Column(Text)
    validated = Column(Boolean)
    account = Column(String(255))
    delivermax = Column(Text)
    destination = Column(String(255))
    fee = Column(String(20))
    flags = Column(Float)
    lastledgersequence = Column(BigInteger)
    sequence = Column(BigInteger)
    signingpubkey = Column(Text)
    transactiontype = Column(String(50))
    txnsignature = Column(Text)
    date = Column(BigInteger)
    memos = Column(Text)

    __table_args__ = (
        Index('idx_account_destination', 'account', 'destination'),
        Index('idx_close_time_iso', 'close_time_iso', postgresql_desc=True),
    )
