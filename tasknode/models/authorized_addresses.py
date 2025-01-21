from sqlalchemy import Column, String, DateTime, Boolean, CheckConstraint, func, Index
from ..database import Base

class AuthorizedAddresses(Base):
    __tablename__ = 'authorized_addresses'

    address = Column(String(255), primary_key=True)
    authorized_at = Column(DateTime(timezone=True), server_default=func.current_timestamp())
    is_authorized = Column(Boolean, server_default='true')
    deauthorized_at = Column(DateTime(timezone=True))
    auth_source = Column(String(50))
    auth_source_user_id = Column(String(50))
    flag_type = Column(String(10))
    flag_expires_at = Column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "flag_type IN ('YELLOW', 'RED') OR flag_type IS NULL",
            name='valid_flag_type'
        ),
        CheckConstraint(
            "address ~ '^r[1-9A-HJ-NP-Za-km-z]{25,34}$'",
            name='valid_xrp_address'
        ),
        Index('idx_authorized_addresses_source', 'auth_source', 'auth_source_user_id'),
    ) 