ALTER TABLE hive_reports
  DROP CONSTRAINT IF EXISTS hive_reports_type_chk;

ALTER TABLE hive_reports
  ADD CONSTRAINT hive_reports_type_chk
  CHECK (type IN (
    'operative',
    'rewarded_task',
    'kol',
    'development',
    'qa',
    'executive',
    'hive_intelligence',
    'board_manager_planning'
  ));
