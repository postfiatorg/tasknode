from sqlalchemy import Column, String, Text, DateTime, ForeignKey, Boolean, func
from ..database import Base

class TransactionProcessingResults(Base):
    __tablename__ = 'transaction_processing_results'

    hash = Column(String(255), ForeignKey('postfiat_tx_cache.hash'), primary_key=True)
    processed = Column(Boolean, nullable=False)
    rule_name = Column(String(255))
    response_tx_hash = Column(String(255))
    notes = Column(Text)
    reviewed_at = Column(DateTime, server_default=func.current_timestamp())