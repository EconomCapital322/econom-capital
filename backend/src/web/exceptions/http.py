from web.repositories.models import CalculationError
from web.schemas.responses import ErrorDetail, ErrorInfo


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: list[dict[str, str]] | None = None,
        saved_error: CalculationError | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.error = (
            ErrorInfo.model_validate(saved_error.model_dump(by_alias=True, exclude_none=True))
            if saved_error is not None
            else ErrorInfo(
                code=code,
                message=message,
                details=[ErrorDetail.model_validate(detail) for detail in details or []],
            )
        )
