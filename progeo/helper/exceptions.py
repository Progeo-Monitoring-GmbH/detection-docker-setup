class SeverException(Exception):  # pragma: no cover
    pass


class MissingEnvironmentVariableError(Exception):  # pragma: no cover
    """Custom exception for missing environment variables."""

    def __init__(self, var_name):
        self.var_name = var_name
        super().__init__(f"Missing environment variable: {var_name}")
