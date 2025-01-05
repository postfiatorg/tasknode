class GoogleDocNotFoundException(Exception):
    """ This exception is raised when the Google Doc is not found """
    def __init__(self, google_url):
        super().__init__(f"Google Doc not found: {google_url}")

class InvalidGoogleDocException(Exception):
    """ This exception is raised when the google doc is not valid """
    def __init__(self, google_url):
        super().__init__(f"Invalid Google Doc URL: {google_url}")

class GoogleDocIsNotSharedException(Exception):
    """ This exception is raised when the google doc is not shared """
    def __init__(self, google_url):
        super().__init__(f"Google Doc is not shared: {google_url}")
