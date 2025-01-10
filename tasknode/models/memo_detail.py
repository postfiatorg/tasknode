from sqlalchemy import Column, String, BigInteger, Text, Boolean, Float, DateTime, Date, select, text
from sqlalchemy.dialects.postgresql import JSONB
from ..database import Base
from .postfiat_tx import PostfiatTxCache

class MemoDetailView(Base):
    __tablename__ = 'memo_detail_view'
    __table_args__ = {'info': {'is_view': True}}

    # Include all columns from PostfiatTxCache
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

    # Additional computed columns from the view
    tx_json_parsed = Column(JSONB)
    meta_parsed = Column(JSONB)
    transaction_result = Column(String)
    has_memos = Column(Boolean)
    datetime = Column(DateTime)
    pft_absolute_amount = Column(Float)
    simple_date = Column(Date)
    main_memo_data = Column(JSONB)

    # Define the view query
    __view__ = select([
        PostfiatTxCache,
        text("tx_json::jsonb as tx_json_parsed"),
        text("meta::jsonb as meta_parsed"),
        text("meta::jsonb->>'TransactionResult' as transaction_result"),
        text("(tx_json::jsonb->'Memos') IS NOT NULL as has_memos"),
        text("(close_time_iso::timestamp) as datetime"),
        text("COALESCE((tx_json::jsonb->'DeliverMax'->>'value')::float, 0) as pft_absolute_amount"),
        text("(close_time_iso::timestamp)::date as simple_date"),
        text("(tx_json::jsonb->'Memos'->0->'Memo') as main_memo_data")
    ]).where(
        text("(tx_json::jsonb->'Memos') IS NOT NULL")
    ).cte('memo_base').select()
