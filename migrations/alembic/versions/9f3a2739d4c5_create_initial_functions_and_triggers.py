"""create initial functions and triggers

Revision ID: 9f3a2739d4c5
Revises: f4c034501755
Create Date: 2025-01-20 16:58:17.971287

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9f3a2739d4c5'
down_revision: Union[str, None] = 'f4c034501755'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create decode_hex_memo function
    op.execute(r"""
        CREATE FUNCTION decode_hex_memo(memo_text text) RETURNS text
            LANGUAGE plpgsql
            AS $$
        BEGIN
            RETURN CASE 
                WHEN memo_text IS NULL THEN ''
                WHEN POSITION('\x' in memo_text) = 1 THEN 
                    convert_from(decode(substring(memo_text from 3), 'hex'), 'UTF8')
                ELSE 
                    convert_from(decode(memo_text, 'hex'), 'UTF8')
            END;
        END;
        $$;
    """)
    op.execute('ALTER FUNCTION decode_hex_memo(memo_text text) OWNER TO postfiat')

    # Create find_transaction_response function
    op.execute("""
        CREATE FUNCTION find_transaction_response(request_account text, request_destination text, request_time text, response_memo_type text, response_memo_format text DEFAULT NULL::text, response_memo_data text DEFAULT NULL::text, require_after_request boolean DEFAULT true) RETURNS TABLE(hash character varying, account character varying, destination character varying, memo_type text, memo_format text, memo_data text, transaction_result character varying, close_time_iso timestamp without time zone)
            LANGUAGE plpgsql
            AS $$
        BEGIN
            RETURN QUERY
            SELECT 
                d.hash::VARCHAR(255),
                (d.tx_json_parsed->>'Account')::VARCHAR(255) as account,
                (d.tx_json_parsed->>'Destination')::VARCHAR(255) as destination,
                d.memo_type,
                d.memo_format,
                d.memo_data,
                d.transaction_result::VARCHAR(255),
                d.close_time_iso::timestamp
            FROM decoded_memos d
            WHERE 
                d.tx_json_parsed->>'Destination' = request_account
                AND d.transaction_result = 'tesSUCCESS'
                AND (
                    NOT require_after_request 
                    OR d.close_time_iso::timestamp > request_time::timestamp
                )
                AND d.memo_type = response_memo_type
                AND (response_memo_format IS NULL OR d.memo_format = response_memo_format)
                AND (response_memo_data IS NULL OR d.memo_data LIKE response_memo_data)
            ORDER BY d.close_time_iso ASC
            LIMIT 1;
        END;
        $$;
    """)
    op.execute('ALTER FUNCTION find_transaction_response(text, text, text, text, text, text, boolean) OWNER TO postfiat')

    # Create process_tx_memos function
    op.execute("""
        CREATE FUNCTION process_tx_memos() RETURNS trigger
            LANGUAGE plpgsql
            AS $$
        BEGIN
            -- Only process if there are memos
            IF (NEW.tx_json::jsonb->'Memos') IS NOT NULL THEN
                INSERT INTO transaction_memos (
                    hash,
                    account,
                    destination,
                    pft_amount,
                    xrp_fee,
                    memo_format,
                    memo_type,
                    memo_data,
                    datetime,
                    transaction_result
                ) VALUES (
                    NEW.hash,
                    (NEW.tx_json::jsonb->>'Account'),
                    (NEW.tx_json::jsonb->>'Destination'),
                    NULLIF((NEW.meta::jsonb->'delivered_amount'->>'value')::NUMERIC, 0),
                    NULLIF((NEW.tx_json::jsonb->>'Fee')::NUMERIC, 0) / 1000000,
                    decode_hex_memo((NEW.tx_json::jsonb->'Memos'->0->'Memo'->>'MemoFormat')),
                    decode_hex_memo((NEW.tx_json::jsonb->'Memos'->0->'Memo'->>'MemoType')),
                    decode_hex_memo((NEW.tx_json::jsonb->'Memos'->0->'Memo'->>'MemoData')),
                    (NEW.close_time_iso::timestamp),
                    (NEW.meta::jsonb->>'TransactionResult')
                )
                ON CONFLICT (hash) 
                DO UPDATE SET
                    account = EXCLUDED.account,
                    destination = EXCLUDED.destination,
                    pft_amount = EXCLUDED.pft_amount,
                    xrp_fee = EXCLUDED.xrp_fee,
                    memo_format = EXCLUDED.memo_format,
                    memo_type = EXCLUDED.memo_type,
                    memo_data = EXCLUDED.memo_data,
                    datetime = EXCLUDED.datetime,
                    transaction_result = EXCLUDED.transaction_result;
            END IF;

            RETURN NEW;
        END;
        $$;
    """)
    op.execute('ALTER FUNCTION process_tx_memos() OWNER TO postfiat')

    # Create update_pft_holders function
    op.execute("""
        CREATE FUNCTION update_pft_holders() RETURNS trigger
            LANGUAGE plpgsql
            AS $$
        DECLARE
            meta_parsed JSONB;
            current_balance NUMERIC;
        BEGIN
            -- Skip if transaction wasn't successful
            IF NEW.transaction_result != 'tesSUCCESS' THEN
                RETURN NEW;
            END IF;

            -- Process sender's balance
            IF NEW.account IS NOT NULL AND NEW.pft_amount IS NOT NULL THEN
                -- Get current balance or default to 0
                SELECT balance INTO current_balance
                FROM pft_holders
                WHERE account = NEW.account;

                IF current_balance IS NULL THEN
                    current_balance := 0;
                END IF;

                -- Update sender's balance (subtract amount sent)
                INSERT INTO pft_holders (account, balance, last_updated, last_tx_hash)
                VALUES (
                    NEW.account,
                    current_balance - NEW.pft_amount,
                    NEW.datetime,
                    NEW.hash
                )
                ON CONFLICT (account) DO UPDATE
                SET 
                    balance = EXCLUDED.balance,
                    last_updated = EXCLUDED.last_updated,
                    last_tx_hash = EXCLUDED.last_tx_hash;
            END IF;

            -- Process recipient's balance
            IF NEW.destination IS NOT NULL AND NEW.pft_amount IS NOT NULL THEN
                -- Get current balance or default to 0
                SELECT balance INTO current_balance
                FROM pft_holders
                WHERE account = NEW.destination;

                IF current_balance IS NULL THEN
                    current_balance := 0;
                END IF;

                -- Update recipient's balance (add amount received)
                INSERT INTO pft_holders (account, balance, last_updated, last_tx_hash)
                VALUES (
                    NEW.destination,
                    current_balance + NEW.pft_amount,
                    NEW.datetime,
                    NEW.hash
                )
                ON CONFLICT (account) DO UPDATE
                SET 
                    balance = EXCLUDED.balance,
                    last_updated = EXCLUDED.last_updated,
                    last_tx_hash = EXCLUDED.last_tx_hash;
            END IF;

            RETURN NEW;
        END;
        $$;
    """)
    op.execute('ALTER FUNCTION update_pft_holders() OWNER TO postfiat')

    # Create triggers
    op.execute("""
        CREATE TRIGGER process_tx_memos_trigger
            AFTER INSERT OR UPDATE ON postfiat_tx_cache
            FOR EACH ROW
            EXECUTE FUNCTION process_tx_memos();
    """)

    op.execute("""
        CREATE TRIGGER update_pft_holders_trigger
            AFTER INSERT ON transaction_memos
            FOR EACH ROW
            EXECUTE FUNCTION update_pft_holders();
    """)


def downgrade() -> None:
    # Drop triggers first
    op.execute('DROP TRIGGER IF EXISTS update_pft_holders_trigger ON transaction_memos')
    op.execute('DROP TRIGGER IF EXISTS process_tx_memos_trigger ON postfiat_tx_cache')

    # Then drop functions
    op.execute('DROP FUNCTION IF EXISTS update_pft_holders()')
    op.execute('DROP FUNCTION IF EXISTS process_tx_memos()')
    op.execute('DROP FUNCTION IF EXISTS find_transaction_response(text, text, text, text, text, text, boolean)')
    op.execute('DROP FUNCTION IF EXISTS decode_hex_memo(text)')
