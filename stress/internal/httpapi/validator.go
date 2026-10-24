package httpapi

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"

	"github.com/mrsskaa/curves-module/stress/internal/stress"
)

const (
	baseCurveCode          string = "base"
	parametersStandardMode string = "standard"
	parametersCustomMode   string = "custom"
)

var (
	decimalPattern = regexp.MustCompile(
		`^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`,
	)
)

func validateAndConvert(
	req CalculateRequest,
) ([]stress.Point, stress.Parameters, error) {
	base := req.Base
	parameters := req.Parameters

	points, err := getBaseCurvePoints(base)
	if err != nil {
		return nil, stress.Parameters{}, err
	}

	p, exactP, err := parseDecimal(parameters.P)
	if err != nil || !isValidScenarioParameter(exactP) {
		return nil, stress.Parameters{}, fmt.Errorf(
			"%w: %w", err, ErrInvalidParameters,
		)
	}

	k, exactK, err := parseDecimal(parameters.K)
	if err != nil || !isValidScenarioParameter(exactK) {
		return nil, stress.Parameters{}, fmt.Errorf(
			"%w: %w", err, ErrInvalidParameters,
		)
	}

	d, exactD, err := parseDecimal(parameters.D)
	if err != nil || !isValidScenarioParameter(exactD) {
		return nil, stress.Parameters{}, fmt.Errorf(
			"%w: %w", err, ErrInvalidParameters,
		)
	}

	if parameters.Mode != parametersStandardMode &&
		parameters.Mode != parametersCustomMode {
		return nil, stress.Parameters{}, fmt.Errorf(
			"unknown parameters mode: %w",
			ErrInvalidParameters,
		)
	}

	if parameters.Mode == parametersStandardMode {
		if exactP.Cmp(big.NewRat(4, 1)) != 0 ||
			exactK.Cmp(big.NewRat(5, 1)) != 0 ||
			exactD.Cmp(big.NewRat(3, 1)) != 0 {
			return nil, stress.Parameters{}, fmt.Errorf(
				"standard parameters require P=4, K=5, D=3: %w",
				ErrInvalidParameters,
			)
		}
	}

	return points, stress.Parameters{
		P: p,
		K: k,
		D: d,
	}, nil
}

func isValidScenarioParameter(value *big.Rat) bool {
	return value.Sign() > 0 && value.Cmp(big.NewRat(25, 1)) <= 0
}

func getBaseCurvePoints(
	base BaseCurveRequest,
) ([]stress.Point, error) {
	points := make([]stress.Point, len(base.Points))

	if base.CurveCode != baseCurveCode {
		return nil, fmt.Errorf(
			"base curve code is invalid: %w",
			ErrInvalidBaseCurve,
		)
	}

	for i, point := range base.Points {
		if point.IsExtrapolated == nil || point.IsInterpolated == nil {
			return nil, fmt.Errorf(
				"is_extrapolated and is_interpolated are required: %w",
				ErrInvalidBaseCurve,
			)
		}

		if *point.IsExtrapolated && *point.IsInterpolated {
			return nil, fmt.Errorf(
				"base curve point cannot be both interpolated and extrapolated: %w",
				ErrInvalidBaseCurve,
			)
		}

		tenor, exactTenor, err := parseDecimal(point.TenorYears)
		if err != nil || exactTenor.Sign() <= 0 {
			return nil, fmt.Errorf(
				"%w: %w", err, ErrInvalidBaseCurve,
			)
		}

		rate, _, err := parseDecimal(point.RatePercent)
		if err != nil {
			return nil, fmt.Errorf(
				"%w: %w", err, ErrInvalidBaseCurve,
			)
		}

		points[i] = stress.Point{
			BucketLabel: point.BucketLabel,
			TenorYears:  tenor,
			RatePercent: rate,
		}
	}

	return points, nil
}

func parseDecimal(s string) (float64, *big.Rat, error) {
	if !decimalPattern.MatchString(s) {
		return 0, nil, errors.New("expected a decimal string")
	}

	exact, ok := new(big.Rat).SetString(s)
	if !ok {
		return 0, nil, errors.New("invalid decimal")
	}

	value, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, nil, errors.New("number is outside float64 range")
	}

	if exact.Sign() != 0 && value == 0 {
		return 0, nil, errors.New("nonzero number is too small for float64")
	}

	return value, exact, nil
}
