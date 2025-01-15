from nodetools.sql.schema_extension import SchemaExtension
from nodetools.sql.sql_manager import SQLManager
from typing import List, Tuple

class WalletSchemaExtension(SchemaExtension):
    def __init__(self):
        self.sql_manager = SQLManager('tasknode/sql')

    def get_table_definitions(self) -> List[str]:
        return self.sql_manager.load_statements('init', 'create_tables')

    def get_function_definitions(self) -> List[str]:
        return []
    
    def get_trigger_definitions(self) -> List[str]:
        return []
    
    def get_view_definitions(self) -> List[str]:
        return []
    
    def get_index_definitions(self) -> List[str]:
        return self.sql_manager.load_statements('init', 'create_indices')
    
    def get_privileges(self) -> List[Tuple[str, str]]:
        return [('user_wallet_seeds', 'ALL')]