// Package basecurve builds a piecewise linear curve on an explicit bucket grid.
package basecurve

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"strings"
)

const (
	Version   = "linear-v1"
	Method    = "linear"
	Precision = 34
)

type RatePoint struct {
	TenorYears  string `json:"tenor_years"`
	RatePercent string `json:"rate_percent"`
}

type Bucket struct {
	BucketLabel string `json:"bucket_label"`
	TenorYears  string `json:"tenor_years"`
}

type Spec struct {
	BaseVersion   string   `json:"base_version"`
	StressVersion string   `json:"stress_version"`
	Method        string   `json:"method"`
	DayCount      string   `json:"day_count"`
	Grid          []Bucket `json:"grid"`
}

type Point struct {
	BucketLabel    string `json:"bucket_label"`
	TenorYears     string `json:"tenor_years"`
	RatePercent    string `json:"rate_percent"`
	IsInterpolated bool   `json:"is_interpolated"`
	IsExtrapolated bool   `json:"is_extrapolated"`
}

type Curve struct {
	CurveCode string  `json:"curve_code"`
	Points    []Point `json:"points"`
}

type sourcePoint struct {
	tenor *big.Rat
	rate  *big.Rat
	raw   RatePoint
}

var decimalPattern = regexp.MustCompile(`^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`)

// Build preserves exact source rates and rounds calculated rates once to 34
// significant decimal digits, half to even. No float conversion is performed.
// All tenors are already in years; day_count is metadata, not date conversion.
func Build(points []RatePoint, spec Spec) (Curve, error) {
	if spec.BaseVersion != Version {
		return Curve{}, fmt.Errorf("Unsupported base version: %s", spec.BaseVersion)
	}
	if spec.Method != Method {
		return Curve{}, fmt.Errorf("Unsupported base method: %s", spec.Method)
	}
	if strings.TrimSpace(spec.DayCount) == "" || strings.TrimSpace(spec.StressVersion) == "" {
		return Curve{}, errors.New("day_count and stress_version metadata are required")
	}
	sources, err := parseSources(points)
	if err != nil {
		return Curve{}, err
	}
	tenors, err := parseGrid(spec.Grid)
	if err != nil {
		return Curve{}, err
	}
	result := Curve{CurveCode: "base", Points: make([]Point, len(spec.Grid))}
	for i, bucket := range spec.Grid {
		tenor := tenors[i]
		position, exact := slices.BinarySearchFunc(sources, tenor, func(p sourcePoint, t *big.Rat) int {
			return p.tenor.Cmp(t)
		})
		point := Point{BucketLabel: bucket.BucketLabel, TenorYears: bucket.TenorYears}
		if exact {
			point.RatePercent = sources[position].raw.RatePercent
		} else {
			point.IsExtrapolated = position == 0 || position == len(sources)
			point.IsInterpolated = !point.IsExtrapolated
			segment := max(0, min(position-1, len(sources)-2))
			point.RatePercent = interpolate(sources[segment], sources[segment+1], tenor)
		}
		result.Points[i] = point
	}
	return result, nil
}

func parseSources(points []RatePoint) ([]sourcePoint, error) {
	if len(points) < 2 {
		return nil, errors.New("At least two source points are required for a linear curve")
	}
	sources := make([]sourcePoint, len(points))
	for i, point := range points {
		tenor, err := parseDecimal(point.TenorYears)
		if err != nil || tenor.Sign() <= 0 {
			return nil, fmt.Errorf("source point %d: tenor_years must be a positive decimal", i)
		}
		rate, err := parseDecimal(point.RatePercent)
		if err != nil {
			return nil, fmt.Errorf("source point %d: invalid rate_percent: %w", i, err)
		}
		sources[i] = sourcePoint{tenor: tenor, rate: rate, raw: point}
	}
	slices.SortFunc(sources, func(left, right sourcePoint) int { return left.tenor.Cmp(right.tenor) })
	for i := 1; i < len(sources); i++ {
		if sources[i-1].tenor.Cmp(sources[i].tenor) == 0 {
			return nil, errors.New("Source tenors must be unique")
		}
	}
	return sources, nil
}

func parseGrid(grid []Bucket) ([]*big.Rat, error) {
	if len(grid) == 0 {
		return nil, errors.New("grid must contain at least one bucket")
	}
	labels := make(map[string]bool, len(grid))
	tenors := make([]*big.Rat, len(grid))
	for i, bucket := range grid {
		if strings.TrimSpace(bucket.BucketLabel) == "" || labels[bucket.BucketLabel] {
			return nil, errors.New("grid labels must be nonempty and unique")
		}
		labels[bucket.BucketLabel] = true
		tenor, err := parseDecimal(bucket.TenorYears)
		if err != nil || tenor.Sign() <= 0 {
			return nil, fmt.Errorf("bucket %d: tenor_years must be a positive decimal", i)
		}
		if i > 0 && tenors[i-1].Cmp(tenor) >= 0 {
			return nil, errors.New("grid tenors must be strictly increasing and unique")
		}
		tenors[i] = tenor
	}
	return tenors, nil
}

func parseDecimal(value string) (*big.Rat, error) {
	if !decimalPattern.MatchString(value) {
		return nil, errors.New("expected a finite decimal string")
	}
	number, ok := new(big.Rat).SetString(value)
	if !ok {
		return nil, errors.New("invalid decimal string")
	}
	return number, nil
}

func interpolate(left, right sourcePoint, tenor *big.Rat) string {
	deltaRate := new(big.Rat).Sub(right.rate, left.rate)
	deltaTenor := new(big.Rat).Sub(right.tenor, left.tenor)
	weight := new(big.Rat).Quo(new(big.Rat).Sub(tenor, left.tenor), deltaTenor)
	rate := new(big.Rat).Add(left.rate, new(big.Rat).Mul(deltaRate, weight))
	return roundDecimal(rate)
}

// roundDecimal uses integer division and a tie-to-even decision in base 10.
// It avoids binary floating point and rounding intermediate slopes.
func roundDecimal(value *big.Rat) string {
	if value.Sign() == 0 {
		return "0"
	}
	numerator := new(big.Int).Abs(value.Num())
	denominator := new(big.Int).Set(value.Denom())
	exponent := len(numerator.String()) - len(denominator.String())
	if exponent >= 0 {
		if numerator.Cmp(new(big.Int).Mul(denominator, power10(exponent))) < 0 {
			exponent--
		}
	} else if new(big.Int).Mul(numerator, power10(-exponent)).Cmp(denominator) < 0 {
		exponent--
	}
	scale := Precision - 1 - exponent
	if scale >= 0 {
		numerator.Mul(numerator, power10(scale))
	} else {
		denominator.Mul(denominator, power10(-scale))
	}
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, denominator, remainder)
	tie := new(big.Int).Lsh(remainder, 1).Cmp(denominator)
	if tie > 0 || (tie == 0 && quotient.Bit(0) == 1) {
		quotient.Add(quotient, big.NewInt(1))
	}
	text := quotient.String()
	if scale > 0 {
		if len(text) <= scale {
			text = strings.Repeat("0", scale+1-len(text)) + text
		}
		index := len(text) - scale
		text = strings.TrimRight(strings.TrimRight(text[:index]+"."+text[index:], "0"), ".")
	} else {
		text += strings.Repeat("0", -scale)
	}
	if value.Sign() < 0 {
		text = "-" + text
	}
	return text
}

func power10(exponent int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(exponent)), nil)
}
