class MarketTemporaryError(Exception):
    """Temporary source failure eligible for bounded retry."""


class MarketPermanentError(Exception):
    """A permanent source failure, ineligible for retry."""


class InvalidMarketData(MarketPermanentError, ValueError):
    """The source responded with an invalid or inconsistent snapshot."""


class NoMarketData(Exception):
    """The source successfully reported no data for exactly the requested date."""


class LoaderAlreadyRunning(Exception):
    """A loader for this date already holds the local process lock."""
