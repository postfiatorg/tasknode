from sqlalchemy import Column, String, Numeric, DateTime, Index
from ..database import Base

class PftHolders(Base):
    __tablename__ = 'pft_holders'

    account = Column(String(255), primary_key=True)
    balance = Column(Numeric, nullable=False, server_default='0')
    last_updated = Column(DateTime, nullable=False)
    last_tx_hash = Column(String(255))

    __table_args__ = (
        Index('idx_pft_holders_balance', 'balance'),
    ) 