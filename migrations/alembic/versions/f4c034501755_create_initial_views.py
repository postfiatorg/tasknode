"""create initial views

Revision ID: f4c034501755
Revises: bd5556abda5f
Create Date: 2025-01-20 16:54:40.104328

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f4c034501755'
down_revision: Union[str, None] = 'bd5556abda5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create decoded_memos view
    op.execute("""
        CREATE VIEW decoded_memos AS
        WITH parsed_json AS (
            SELECT ptc.hash,
                ptc.ledger_index,
                ptc.close_time_iso,
                ptc.meta,
                ptc.tx_json,
                ptc.validated,
                (ptc.tx_json)::jsonb AS tx_json_parsed,
                (ptc.meta)::jsonb AS meta_parsed
            FROM postfiat_tx_cache ptc
        )
        SELECT p.hash,
            p.ledger_index,
            p.close_time_iso,
            p.meta,
            p.tx_json,
            p.validated,
            p.tx_json_parsed,
            p.meta_parsed,
            (p.tx_json_parsed ->> 'Account'::text) AS account,
            (p.tx_json_parsed ->> 'Destination'::text) AS destination,
            (p.tx_json_parsed ->> 'Fee'::text) AS fee,
            ((p.tx_json_parsed ->> 'Flags'::text))::double precision AS flags,
            ((p.tx_json_parsed ->> 'LastLedgerSequence'::text))::bigint AS lastledgersequence,
            ((p.tx_json_parsed ->> 'Sequence'::text))::bigint AS sequence,
            (p.tx_json_parsed ->> 'TransactionType'::text) AS transactiontype,
            tm.memo_format,
            tm.memo_type,
            tm.memo_data,
            (p.meta_parsed ->> 'TransactionResult'::text) AS transaction_result,
            ((p.tx_json_parsed -> 'Memos'::text) IS NOT NULL) AS has_memos,
            (p.close_time_iso)::timestamp without time zone AS datetime,
            COALESCE((((p.meta_parsed -> 'delivered_amount'::text) ->> 'value'::text))::double precision, (0)::double precision) AS pft_absolute_amount,
            ((p.close_time_iso)::timestamp without time zone)::date AS simple_date,
            (((p.tx_json_parsed -> 'Memos'::text) -> 0) -> 'Memo'::text) AS main_memo_data
        FROM (parsed_json p
            LEFT JOIN transaction_memos tm ON (((p.hash)::text = (tm.hash)::text)))
    """)

    # Create enriched_transaction_results view
    op.execute("""
        CREATE VIEW enriched_transaction_results AS
        SELECT r.hash,
            r.processed,
            r.rule_name,
            r.response_tx_hash,
            r.notes,
            r.reviewed_at,
            m.account,
            m.destination,
            m.pft_amount,
            m.xrp_fee,
            m.memo_format,
            m.memo_type,
            m.memo_data,
            m.datetime,
            m.transaction_result
        FROM (transaction_processing_results r
            LEFT JOIN transaction_memos m ON (((r.hash)::text = (m.hash)::text)))
    """)

    # Set view ownership
    op.execute('ALTER VIEW decoded_memos OWNER TO postfiat')
    op.execute('ALTER VIEW enriched_transaction_results OWNER TO postfiat')


def downgrade() -> None:
    op.execute('DROP VIEW IF EXISTS enriched_transaction_results')
    op.execute('DROP VIEW IF EXISTS decoded_memos')
