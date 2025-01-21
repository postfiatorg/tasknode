from sqlalchemy import Column, String, Numeric, Text, DateTime, ForeignKey, Index
from ..database import Base

class TransactionMemos(Base):
    __tablename__ = 'transaction_memos'

    hash = Column(String(255), ForeignKey('postfiat_tx_cache.hash', ondelete='CASCADE'), primary_key=True)
    account = Column(String(255))
    destination = Column(String(255))
    pft_amount = Column(Numeric)
    xrp_fee = Column(Numeric)
    memo_format = Column(Text, server_default='')
    memo_type = Column(Text, server_default='')
    memo_data = Column(Text, server_default='')
    datetime = Column(DateTime)
    transaction_result = Column(String(50))

    __table_args__ = (
        Index('idx_account_destination', 'account', 'destination'),
        Index('idx_memo_fields', 'memo_type', 'memo_format', 'memo_data'),
    ) 