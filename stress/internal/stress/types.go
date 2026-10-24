package stress

import "fmt"

type curveCode string

const (
	parallel_up     curveCode = "parallel_up"
	parallel_down   curveCode = "parallel_down"
	steepener       curveCode = "steepener"
	flattener       curveCode = "flattener"
	short_rate_up   curveCode = "short_rate_up"
	short_rate_down curveCode = "short_rate_down"
)

type Point struct {
	BucketLabel string
	TenorYears  float64
	RatePercent float64
}

type Parameters struct {
	P float64
	K float64
	D float64
}

type Curve struct {
	Code   curveCode
	Points []Point
}

func GetDefaultParameters() Parameters {
	return Parameters{
		P: 4,
		K: 5,
		D: 3,
	}
}

func (p *Parameters) Validate() error {
	if err := validateParameter(p.P, "P"); err != nil {
		return err
	}
	if err := validateParameter(p.K, "K"); err != nil {
		return err
	}
	if err := validateParameter(p.D, "D"); err != nil {
		return err
	}

	return nil
}

func validateParameter(val float64, label string) error {
	if !isFinite(val) || !(0 < val && val <= 25) {
		return fmt.Errorf(
			"invalid %s parameter: %w",
			label, ErrInvalidParameters,
		)
	}

	return nil
}
