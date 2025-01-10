from sqlalchemy import Column, String, Text, Float, DateTime
from sqlalchemy.sql import func
from ..database import Base

class FoundationDiscord(Base):
    __tablename__ = 'foundation_discord'

    hash = Column(String(255), primary_key=True)
    memo_data = Column(Text)
    memo_type = Column(String(255))
    memo_format = Column(String(255))
    datetime = Column(DateTime)
    url = Column(Text)
    directional_pft = Column(Float)
    account = Column(String(255))
    processed_at = Column(DateTime, server_default=func.now())
