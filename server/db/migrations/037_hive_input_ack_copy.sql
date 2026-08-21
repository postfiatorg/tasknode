UPDATE chat_messages
SET body = 'Hive input saved to Hive Context. Hive may respond here if important.'
WHERE role = 'assistant'
  AND metadata_json->>'kind' = 'hive_input_ack'
  AND body = 'Hive input saved to Hive Context.';
