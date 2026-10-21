from web.repositories.models import CurveCode


class InputDataNotReady(Exception):
    """Cannot create a curve_run without a complete validated input set."""


class StaleClaim(Exception):
    """The caller no longer owns the current curve_run stage."""


class RunNotFound(Exception):
    """The requested curve_run does not exist."""


class RunStateConflict(Exception):
    """The saved run cannot be used for this operation."""


class ImplementationUnavailable(Exception):
    """A calculation or source implementation has not been connected."""


class WorkerAlreadyRunning(Exception):
    """Another local worker holds the process lock."""


class BaseCurveError(Exception):
    """Base implementation failed."""


class StressCurveError(Exception):
    def __init__(self, message: str, curve_code: CurveCode | None = None) -> None:
        super().__init__(message)
        self.curve_code = curve_code
