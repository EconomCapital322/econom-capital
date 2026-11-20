package stress

import "errors"

var (
	ErrInvalidBaseCurve        = errors.New("invalid base curve")
	ErrInvalidBucketLabel      = errors.New("invalid bucket label")
	ErrInvalidTenorYears       = errors.New("invalid tenor years")
	ErrInvalidRatePercent      = errors.New("invalid rate percent")
	ErrInvalidParameters       = errors.New("invalid parameters")
	ErrInvalidCalculatedCurves = errors.New("invalid calculated curves")
)
