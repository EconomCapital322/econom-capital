package basecurve

import (
	"encoding/json"
	"math/big"
	"os"
	"reflect"
	"strings"
	"testing"
)

func sampleSpec() Spec {
	return Spec{
		BaseVersion: Version, StressVersion: "example-stress-v1", Method: Method, DayCount: "years",
		Grid: []Bucket{{BucketLabel: "2y", TenorYears: "2"}},
	}
}

func TestBuildExcel(t *testing.T) {
	data, err := os.ReadFile("testdata/excel.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Points    []RatePoint `json:"points"`
		Spec      Spec        `json:"spec"`
		Expected  []string    `json:"expected_rates"`
		Tolerance string      `json:"absolute_tolerance_percent"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Points) != 19 || len(fixture.Expected) != 23 {
		t.Fatal("Excel fixture must contain 19 market nodes and 23 bucket rates")
	}
	curve, err := Build(fixture.Points, fixture.Spec)
	if err != nil {
		t.Fatal(err)
	}
	if curve.CurveCode != "base" || len(curve.Points) != len(fixture.Expected) {
		t.Fatal("incomplete base curve")
	}
	tolerance := mustDecimal(t, fixture.Tolerance)
	for i, point := range curve.Points {
		difference := new(big.Rat).Sub(mustDecimal(t, point.RatePercent), mustDecimal(t, fixture.Expected[i]))
		if difference.Abs(difference).Cmp(tolerance) > 0 {
			t.Errorf("%s: rate %s, expected %s", point.BucketLabel, point.RatePercent, fixture.Expected[i])
		}
		if point.BucketLabel != fixture.Spec.Grid[i].BucketLabel || point.TenorYears != fixture.Spec.Grid[i].TenorYears {
			t.Errorf("bucket %d: grid changed", i)
		}
		if point.IsInterpolated != (i > 0 && i < 19) || point.IsExtrapolated != (i >= 19) {
			t.Errorf("bucket %s: invalid provenance", point.BucketLabel)
		}
	}
}

func TestBuildPreservesInputAndSourceRate(t *testing.T) {
	rate := "14.123456789012345678901234567890123456789"
	sources := []RatePoint{{TenorYears: "3", RatePercent: "1"}, {TenorYears: "1", RatePercent: rate}}
	before := append([]RatePoint(nil), sources...)
	spec := sampleSpec()
	spec.Grid = []Bucket{{BucketLabel: "1y", TenorYears: "1.00"}}
	curve, err := Build(sources, spec)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sources, before) {
		t.Fatal("source input was modified")
	}
	point := curve.Points[0]
	if point.RatePercent != rate || point.TenorYears != "1.00" || point.IsInterpolated || point.IsExtrapolated {
		t.Fatal("an exact source node must retain its rate and the supplied bucket tenor")
	}
}

func TestBuildValidation(t *testing.T) {
	sources := []RatePoint{{TenorYears: "1", RatePercent: "-2"}, {TenorYears: "3", RatePercent: "2"}}
	tests := []struct {
		name   string
		points []RatePoint
		change func(*Spec)
	}{
		{name: "no_sources"},
		{name: "one_source", points: sources[:1]},
		{name: "duplicate_sources", points: []RatePoint{{TenorYears: "1", RatePercent: "2"}, {TenorYears: "1.0", RatePercent: "3"}}},
		{name: "zero_source_tenor", points: []RatePoint{{TenorYears: "0", RatePercent: "2"}, sources[1]}},
		{name: "negative_source_tenor", points: []RatePoint{{TenorYears: "-1", RatePercent: "2"}, sources[1]}},
		{name: "nan_rate", points: []RatePoint{{TenorYears: "1", RatePercent: "NaN"}, sources[1]}},
		{name: "fraction_not_decimal", points: []RatePoint{{TenorYears: "1/2", RatePercent: "2"}, sources[1]}},
		{name: "unknown_method", points: sources, change: func(s *Spec) { s.Method = "cubic" }},
		{name: "unknown_version", points: sources, change: func(s *Spec) { s.BaseVersion = "v2" }},
		{name: "no_day_count", points: sources, change: func(s *Spec) { s.DayCount = "" }},
		{name: "no_stress_version", points: sources, change: func(s *Spec) { s.StressVersion = "" }},
		{name: "no_grid", points: sources, change: func(s *Spec) { s.Grid = nil }},
		{name: "empty_label", points: sources, change: func(s *Spec) { s.Grid[0].BucketLabel = " " }},
		{name: "zero_bucket_tenor", points: sources, change: func(s *Spec) { s.Grid[0].TenorYears = "0" }},
		{name: "infinite_bucket_tenor", points: sources, change: func(s *Spec) { s.Grid[0].TenorYears = "Infinity" }},
		{name: "duplicate_labels", points: sources, change: func(s *Spec) { s.Grid = []Bucket{{"a", "1"}, {"a", "2"}} }},
		{name: "unordered_grid", points: sources, change: func(s *Spec) { s.Grid = []Bucket{{"a", "2"}, {"b", "1"}} }},
		{name: "duplicate_grid_tenors", points: sources, change: func(s *Spec) { s.Grid = []Bucket{{"a", "1"}, {"b", "1.0"}} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			spec := sampleSpec()
			if test.change != nil {
				test.change(&spec)
			}
			curve, err := Build(test.points, spec)
			if err == nil || len(curve.Points) != 0 {
				t.Fatal("invalid input must fail without a partial curve")
			}
		})
	}
}

func TestDecimalRounding(t *testing.T) {
	tests := []struct{ value, expected string }{
		{"0", "0"},
		{"1/3", "0." + strings.Repeat("3", 34)},
		{"-2/3", "-0." + strings.Repeat("6", 33) + "7"},
		{"1e50", "1" + strings.Repeat("0", 50)},
		{"1e-50", "0." + strings.Repeat("0", 49) + "1"},
		{"1." + strings.Repeat("0", 32) + "25", "1." + strings.Repeat("0", 32) + "2"},
		{"1." + strings.Repeat("0", 32) + "35", "1." + strings.Repeat("0", 32) + "4"},
		{strings.Repeat("9", 34) + "5", "1" + strings.Repeat("0", 35)},
	}
	for _, test := range tests {
		t.Run(test.value, func(t *testing.T) {
			value, ok := new(big.Rat).SetString(test.value)
			if !ok {
				t.Fatal("invalid test input")
			}
			if got := roundDecimal(value); got != test.expected {
				t.Errorf("got %s, expected %s", got, test.expected)
			}
		})
	}
}

func mustDecimal(t *testing.T, value string) *big.Rat {
	t.Helper()
	result, err := parseDecimal(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
