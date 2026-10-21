class MarketTemporaryError(Exception):
    """Temporary source failure eligible for bounded retry."""


class MarketPermanentError(Exception):
    """Invalid source data or a permanent source failure."""


class NoMarketData(Exception):
    """The source successfully reported no data for exactly the requested date."""


class LoaderAlreadyRunning(Exception):
    """A loader for this date already holds the local process lock."""
