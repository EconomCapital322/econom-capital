package stress

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"slices"
	"testing"
)

// FIXME: float64 and these tolerances require additional curator approval.
// Rates and tolerances are expressed in percentage points, not fractions.
const (
	excelAbsoluteTolerance = 1e-10
	excelRelativeTolerance = 1e-12
)

type fixturePoint struct {
	BucketLabel string  `json:"bucket_label"`
	TenorYears  float64 `json:"tenor_years"`
	RatePercent float64 `json:"rate_percent"`
}

type expectedCurve struct {
	Code  string    `json:"code"`
	Rates []float64 `json:"rates"`
}

type excelFixture struct {
	Parameters Parameters      `json:"parameters"`
	Base       []fixturePoint  `json:"base"`
	Curves     []expectedCurve `json:"expected_curves"`
}

func TestCalculateExcel(t *testing.T) {
	data, err := os.ReadFile("testdata/excel.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture excelFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Base) != 23 || len(fixture.Curves) != 6 {
		t.Fatal("Excel fixture must cover all 23 points and six scenarios from B:X")
	}
	parameters := GetDefaultParameters()
	if parameters != fixture.Parameters {
		t.Fatalf("standard parameters = %+v, Excel parameters = %+v", parameters, fixture.Parameters)
	}
	base := make([]Point, len(fixture.Base))
	for i, point := range fixture.Base {
		base[i] = Point(point)
	}
	original := slices.Clone(base)
	curves, err := Calculate(base, parameters)
	if !slices.Equal(base, original) {
		t.Error("Calculate modified the input base")
	}
	if err != nil {
		t.Fatalf("Calculate rejected the Excel base: %v", err)
	}
	assertCurves(t, curves, original, fixture.Curves)
}

func TestCalculateCustomParameters(t *testing.T) {
	// T = 4*ln(2) gives exp(-T/4) = 1/2. Expected rates below
	// are hand-calculated from that identity, independently of Calculate.
	tests := []struct {
		name       string
		rate       float64
		parameters Parameters
		expected   []expectedCurve
	}{
		{
			name:       "fractional_parameters_and_negative_base",
			rate:       -0.25,
			parameters: Parameters{P: 1.5, K: 2.5, D: 0.75},
			expected: []expectedCurve{
				{Code: "parallel_up", Rates: []float64{1.25}},
				{Code: "parallel_down", Rates: []float64{-1.75}},
				{Code: "steepener", Rates: []float64{-0.725}},
				{Code: "flattener", Rates: []float64{0.525}},
				{Code: "short_rate_up", Rates: []float64{1}},
				{Code: "short_rate_down", Rates: []float64{-1.5}},
			},
		},
		{
			name:       "upper_parameter_boundary",
			rate:       1,
			parameters: Parameters{P: 50, K: 50, D: 50},
			expected: []expectedCurve{
				{Code: "parallel_up", Rates: []float64{51}},
				{Code: "parallel_down", Rates: []float64{-49}},
				{Code: "steepener", Rates: []float64{7.25}},
				{Code: "flattener", Rates: []float64{6}},
				{Code: "short_rate_up", Rates: []float64{26}},
				{Code: "short_rate_down", Rates: []float64{-24}},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			base := []Point{{BucketLabel: "half_decay", TenorYears: 4 * math.Ln2, RatePercent: test.rate}}
			original := slices.Clone(base)
			curves, err := Calculate(base, test.parameters)
			if !slices.Equal(base, original) {
				t.Error("Calculate modified the input base")
			}
			if err != nil {
				t.Fatal(err)
			}
			assertCurves(t, curves, original, test.expected)
		})
	}
}

func TestCalculateResultMemoryIsIndependent(t *testing.T) {
	base := []Point{
		{BucketLabel: "short", TenorYears: 0.5, RatePercent: -0.25},
		{BucketLabel: "long", TenorYears: 7.5, RatePercent: 2.125},
	}
	original := slices.Clone(base)
	curves, err := Calculate(base, GetDefaultParameters())
	if !slices.Equal(base, original) {
		t.Error("Calculate modified the input base")
	}
	if err != nil {
		t.Fatal(err)
	}
	if len(curves) != 6 {
		t.Fatalf("got %d curves, want six", len(curves))
	}
	for _, curve := range curves {
		if len(curve.Points) != len(base) {
			t.Fatalf("%s: got %d points, want %d", curve.Code, len(curve.Points), len(base))
		}
	}
	otherCurve := slices.Clone(curves[1].Points)
	curves[0].Points[0] = Point{BucketLabel: "changed", TenorYears: 100, RatePercent: 100}
	if !slices.Equal(base, original) {
		t.Error("changing a stress curve modified the input base")
	}
	if !slices.Equal(curves[1].Points, otherCurve) {
		t.Error("changing one stress curve modified another")
	}
}

func TestCalculateRejectsInvalidBase(t *testing.T) {
	onePoint := func(tenor, rate float64) []Point {
		return []Point{{BucketLabel: "point", TenorYears: tenor, RatePercent: rate}}
	}
	tests := []struct {
		name string
		base []Point
		want error
	}{
		{name: "nil", base: nil, want: ErrInvalidBaseCurve},
		{name: "empty_slice", base: []Point{}, want: ErrInvalidBaseCurve},
		{
			name: "empty_label",
			base: []Point{{TenorYears: 1, RatePercent: 2}},
			want: ErrInvalidBucketLabel,
		},
		{
			name: "duplicate_labels",
			base: []Point{
				{BucketLabel: "same", TenorYears: 1, RatePercent: 2},
				{BucketLabel: "same", TenorYears: 2, RatePercent: 3},
			},
			want: ErrInvalidBucketLabel,
		},
		{
			name: "duplicate_tenors",
			base: []Point{
				{BucketLabel: "first", TenorYears: 1, RatePercent: 2},
				{BucketLabel: "second", TenorYears: 1, RatePercent: 3},
			},
			want: ErrInvalidTenorYears,
		},
		{
			name: "descending_tenors",
			base: []Point{
				{BucketLabel: "first", TenorYears: 2, RatePercent: 2},
				{BucketLabel: "second", TenorYears: 1, RatePercent: 3},
			},
			want: ErrInvalidTenorYears,
		},
		{name: "zero_tenor", base: onePoint(0, 1), want: ErrInvalidTenorYears},
		{name: "negative_tenor", base: onePoint(-1, 1), want: ErrInvalidTenorYears},
		{name: "nan_tenor", base: onePoint(math.NaN(), 1), want: ErrInvalidTenorYears},
		{name: "positive_infinite_tenor", base: onePoint(math.Inf(1), 1), want: ErrInvalidTenorYears},
		{name: "negative_infinite_tenor", base: onePoint(math.Inf(-1), 1), want: ErrInvalidTenorYears},
		{name: "nan_rate", base: onePoint(1, math.NaN()), want: ErrInvalidRatePercent},
		{name: "positive_infinite_rate", base: onePoint(1, math.Inf(1)), want: ErrInvalidRatePercent},
		{name: "negative_infinite_rate", base: onePoint(1, math.Inf(-1)), want: ErrInvalidRatePercent},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			curves, err := Calculate(test.base, GetDefaultParameters())
			if !errors.Is(err, test.want) {
				t.Errorf("error = %v, want %v", err, test.want)
			}
			if curves != nil {
				t.Error("invalid input returned a result; want nil curves")
			}
		})
	}
}

func TestCalculateRejectsInvalidParameters(t *testing.T) {
	fields := []struct {
		name string
		set  func(*Parameters, float64)
	}{
		{name: "P", set: func(p *Parameters, value float64) { p.P = value }},
		{name: "K", set: func(p *Parameters, value float64) { p.K = value }},
		{name: "D", set: func(p *Parameters, value float64) { p.D = value }},
	}
	values := []struct {
		name  string
		value float64
	}{
		{name: "zero", value: 0},
		{name: "negative", value: -1},
		{name: "just_above_50", value: math.Nextafter(50, math.Inf(1))},
		{name: "nan", value: math.NaN()},
		{name: "positive_infinity", value: math.Inf(1)},
		{name: "negative_infinity", value: math.Inf(-1)},
	}
	for _, field := range fields {
		for _, value := range values {
			t.Run(field.name+"/"+value.name, func(t *testing.T) {
				parameters := GetDefaultParameters()
				field.set(&parameters, value.value)
				base := []Point{{BucketLabel: "point", TenorYears: 1, RatePercent: 2}}
				curves, err := Calculate(base, parameters)
				if !errors.Is(err, ErrInvalidParameters) {
					t.Errorf("error = %v, want %v", err, ErrInvalidParameters)
				}
				if curves != nil {
					t.Error("invalid input returned a result; want nil curves")
				}
			})
		}
	}
}

func assertCurves(t *testing.T, actual []Curve, base []Point, expected []expectedCurve) {
	t.Helper()
	if len(actual) != len(expected) {
		t.Fatalf("got %d curves, want %d", len(actual), len(expected))
	}
	wantByCode := expectedRatesByCode(t, expected, len(base))
	for _, curve := range actual {
		rates, ok := wantByCode[string(curve.Code)]
		if !ok {
			t.Errorf("unexpected or duplicate curve %q", curve.Code)
			continue
		}
		delete(wantByCode, string(curve.Code))
		assertCurvePoints(t, curve, base, rates)
	}
	for code := range wantByCode {
		t.Errorf("missing curve %q", code)
	}
}

func expectedRatesByCode(t *testing.T, expected []expectedCurve, pointCount int) map[string][]float64 {
	t.Helper()
	wantByCode := make(map[string][]float64, len(expected))
	for _, curve := range expected {
		if len(curve.Rates) != pointCount {
			t.Fatalf("%s: expected data has %d rates, want %d", curve.Code, len(curve.Rates), pointCount)
		}
		if _, duplicate := wantByCode[curve.Code]; duplicate {
			t.Fatalf("duplicate expected curve %q", curve.Code)
		}
		wantByCode[curve.Code] = curve.Rates
	}
	return wantByCode
}

func assertCurvePoints(t *testing.T, curve Curve, base []Point, rates []float64) {
	t.Helper()
	if len(curve.Points) != len(base) {
		t.Errorf("%s: got %d points, want %d", curve.Code, len(curve.Points), len(base))
		return
	}
	for i, point := range curve.Points {
		if point.BucketLabel != base[i].BucketLabel || point.TenorYears != base[i].TenorYears {
			t.Errorf("%s point %d: grid changed, got (%q, %.17g), want (%q, %.17g)",
				curve.Code, i, point.BucketLabel, point.TenorYears, base[i].BucketLabel, base[i].TenorYears)
		}
		want := rates[i]
		tolerance := excelAbsoluteTolerance + excelRelativeTolerance*math.Abs(want)
		if math.IsNaN(point.RatePercent) || math.IsInf(point.RatePercent, 0) ||
			math.Abs(point.RatePercent-want) > tolerance {
			t.Errorf("%s bucket %q: rate %.17g, want %.17g within %.3g percentage points",
				curve.Code, point.BucketLabel, point.RatePercent, want, tolerance)
		}
	}
}
