package stress

import (
	"fmt"
	"math"
	"strings"
)

const curvesCount = 6

func Calculate(
	base []Point,
	parameters Parameters,
) ([]Curve, error) {
	if err := validateBase(base); err != nil {
		return nil, err
	}

	if err := parameters.Validate(); err != nil {
		return nil, err
	}

	codes := [curvesCount]curveCode{
		parallel_up,
		parallel_down,
		steepener,
		flattener,
		short_rate_up,
		short_rate_down,
	}

	curves := make([]Curve, len(codes))
	for i, code := range codes {
		curves[i] = Curve{
			Code:   code,
			Points: make([]Point, len(base)),
		}
	}

	// FIXME: float64 и численный допуск надо согласовать
	for pointIdx, point := range base {
		r := point.RatePercent
		t := point.TenorYears

		s := math.Exp(-t / 4)

		shortShock := parameters.K * s
		longShock := parameters.D * (1 - s)

		rates := [curvesCount]float64{
			r + parameters.P,                    // parallel up
			r - parameters.P,                    // parallel down
			r - 0.65*shortShock + 0.9*longShock, // steepener
			r + 0.8*shortShock - 0.6*longShock,  // flattener
			r + shortShock,                      // short rate up
			r - shortShock,                      // short rate down
		}

		for curveIdx, rate := range rates {
			if !isFinite(rate) {
				return nil, fmt.Errorf(
					"non-finite or NaN result for curve %s, bucket %q: %w",
					codes[curveIdx],
					point.BucketLabel,
					ErrInvalidRatePercent,
				)
			}

			stressedPoint := point
			stressedPoint.RatePercent = rate

			curves[curveIdx].Points[pointIdx] = stressedPoint
		}
	}

	if err := validateResultingCurves(curves, base); err != nil {
		return nil, err
	}

	return curves, nil
}

func validateBase(base []Point) error {
	if len(base) == 0 {
		return fmt.Errorf("base is empty: %w", ErrInvalidBaseCurve)
	}

	bucketLabels := make(map[string]struct{})
	var prevPointTenorYears float64
	for _, point := range base {
		if strings.TrimSpace(point.BucketLabel) == "" {
			return fmt.Errorf(
				"empty bucket label: %w",
				ErrInvalidBucketLabel,
			)
		}

		if _, exists := bucketLabels[point.BucketLabel]; exists {
			return fmt.Errorf(
				"bucket label duplicate: %w",
				ErrInvalidBucketLabel,
			)
		}

		bucketLabels[point.BucketLabel] = struct{}{}

		if !isFinite(point.TenorYears) {
			return fmt.Errorf(
				"tenor years is non-finite or NaN: %w",
				ErrInvalidTenorYears,
			)
		}

		if point.TenorYears <= prevPointTenorYears {
			return fmt.Errorf(
				"tenor years must be strictly increasing: %w",
				ErrInvalidTenorYears,
			)
		}

		prevPointTenorYears = point.TenorYears

		if !isFinite(point.RatePercent) {
			return fmt.Errorf(
				"rate percent is non-finite or NaN: %w",
				ErrInvalidRatePercent,
			)
		}
	}

	return nil
}

func validateResultingCurves(curves []Curve, base []Point) error {
	if len(curves) != curvesCount {
		return fmt.Errorf(
			"curves count does not meet the requirements amount (%d): %w",
			curvesCount, ErrInvalidCalculatedCurves,
		)
	}

	for _, curve := range curves {
		if len(curve.Points) != len(base) {
			return fmt.Errorf(
				"points amount mismatch in %s curve: %w",
				curve.Code, ErrInvalidCalculatedCurves,
			)
		}

		for pointIdx, point := range curve.Points {
			if !isFinite(point.RatePercent) {
				return fmt.Errorf(
					"resulting rate percent in %s curve is non-finite or NaN: %w",
					curve.Code, ErrInvalidRatePercent,
				)
			}

			if point.BucketLabel != base[pointIdx].BucketLabel ||
				point.TenorYears != base[pointIdx].TenorYears {
				return fmt.Errorf(
					"bucket label or tenor years field mismatch in %s curve point: %w",
					curve.Code, ErrInvalidCalculatedCurves,
				)
			}
		}
	}

	return nil
}
