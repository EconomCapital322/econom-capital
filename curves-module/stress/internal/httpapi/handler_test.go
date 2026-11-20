package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
)

const calculationPath = "/internal/v1/stress-curves"

// These tolerances are in percentage points and still require curator approval.
const (
	httpAbsoluteTolerance = 1e-10
	httpRelativeTolerance = 1e-12
)

var expectedStressCodes = [...]string{
	"parallel_up", "parallel_down", "steepener", "flattener",
	"short_rate_up", "short_rate_down",
}

func TestHandlerExcel(t *testing.T) {
	// Reuse saved Excel outputs, rather than calculating an oracle with Go math.
	data, err := os.ReadFile("../stress/testdata/excel.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Parameters struct {
			P json.Number `json:"p"`
			K json.Number `json:"k"`
			D json.Number `json:"d"`
		} `json:"parameters"`
		Base []struct {
			BucketLabel string      `json:"bucket_label"`
			TenorYears  json.Number `json:"tenor_years"`
			RatePercent json.Number `json:"rate_percent"`
		} `json:"base"`
		Curves []struct {
			Code  string    `json:"code"`
			Rates []float64 `json:"rates"`
		} `json:"expected_curves"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Base) != 23 || len(fixture.Curves) != len(expectedStressCodes) {
		t.Fatal("Excel fixture must contain 23 points and all six scenarios from B:X")
	}
	request := validCalculationRequest()
	request.Parameters = ParametersRequest{
		Mode: "standard", P: fixture.Parameters.P.String(),
		K: fixture.Parameters.K.String(), D: fixture.Parameters.D.String(),
	}
	request.Base.Points = make([]BasePointRequest, len(fixture.Base))
	for i, point := range fixture.Base {
		// Excel: B is an original point, C:T are interpolated, U:X extrapolated.
		request.Base.Points[i] = BasePointRequest{
			BucketLabel: point.BucketLabel,
			TenorYears:  point.TenorYears.String(), RatePercent: point.RatePercent.String(),
			IsInterpolated: boolPointer(i > 0 && i < 19),
			IsExtrapolated: boolPointer(i >= 19),
		}
	}
	expected := make(map[string][]float64, len(fixture.Curves))
	for _, curve := range fixture.Curves {
		if _, duplicate := expected[curve.Code]; duplicate {
			t.Fatalf("duplicate curve in Excel fixture: %s", curve.Code)
		}
		expected[curve.Code] = curve.Rates
	}
	assertStressResponse(t, performCalculation(t, marshalRequest(t, request)), request, expected)
}

func TestHandlerBaseProvenance(t *testing.T) {
	tests := []struct {
		name         string
		interpolated bool
		extrapolated bool
	}{
		{name: "original"},
		{name: "interpolated", interpolated: true},
		{name: "extrapolated", extrapolated: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validCalculationRequest()
			request.Base.Points[0].IsInterpolated = boolPointer(test.interpolated)
			request.Base.Points[0].IsExtrapolated = boolPointer(test.extrapolated)
			assertStressResponse(t, performCalculation(t, marshalRequest(t, request)), request, nil)
		})
	}
}

func TestHandlerCustomParameters(t *testing.T) {
	// At T=4*ln(2), exp(-T/4)=1/2. These expected rates are hand-calculated.
	tests := []struct {
		name       string
		rate       string
		parameters ParametersRequest
		rates      []float64
	}{
		{
			name: "fractional_parameters_and_negative_base", rate: "-0.25",
			parameters: ParametersRequest{Mode: "custom", P: "1.5", K: "2.5", D: "0.75"},
			rates:      []float64{1.25, -1.75, -0.725, 0.525, 1, -1.5},
		},
		{
			name: "inclusive_upper_boundary", rate: "1",
			parameters: ParametersRequest{Mode: "custom", P: "50", K: "50", D: "50"},
			rates:      []float64{51, -49, 7.25, 6, 26, -24},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validCalculationRequest()
			request.Parameters = test.parameters
			request.Base.Points[0].TenorYears = strconv.FormatFloat(4*math.Ln2, 'g', -1, 64)
			request.Base.Points[0].RatePercent = test.rate
			expected := make(map[string][]float64, len(expectedStressCodes))
			for i, code := range expectedStressCodes {
				expected[code] = []float64{test.rates[i]}
			}
			assertStressResponse(t, performCalculation(t, marshalRequest(t, request)), request, expected)
		})
	}
}

func TestHandlerRejectsInvalidRequest(t *testing.T) {
	tests := []struct {
		name    string
		section string
		field   string
		value   string // JSON literal; empty means omit the field.
	}{
		{"missing_base", "root", "base", ""},
		{"missing_parameters", "root", "parameters", ""},
		{"wrong_curve_code", "base", "curve_code", `"parallel_up"`},
		{"empty_points", "base", "points", `[]`},
		{"missing_interpolated", "point", "is_interpolated", ""},
		{"missing_extrapolated", "point", "is_extrapolated", ""},
		{"null_interpolated", "point", "is_interpolated", `null`},
		{"null_extrapolated", "point", "is_extrapolated", `null`},
		{"string_interpolated", "point", "is_interpolated", `"false"`},
		{"number_extrapolated", "point", "is_extrapolated", `0`},
		{"empty_label", "point", "bucket_label", `""`},
		{"blank_label", "point", "bucket_label", `" \t "`},
		{"zero_tenor", "point", "tenor_years", `"0"`},
		{"negative_tenor", "point", "tenor_years", `"-1"`},
		{"overflowing_tenor", "point", "tenor_years", `"1e309"`},
		{"underflowing_tenor", "point", "tenor_years", `"1e-400"`},
		{"numeric_tenor", "point", "tenor_years", `0.5`},
		{"invalid_rate", "point", "rate_percent", `"oops"`},
		{"nan_rate", "point", "rate_percent", `"NaN"`},
		{"infinite_rate", "point", "rate_percent", `"Infinity"`},
		{"overflowing_rate", "point", "rate_percent", `"1e309"`},
		{"null_rate", "point", "rate_percent", `null`},
		{"numeric_rate", "point", "rate_percent", `14.45`},
		{"missing_mode", "parameters", "mode", ""},
		{"unknown_mode", "parameters", "mode", `"unsupported"`},
		{"missing_p", "parameters", "p", ""},
		{"zero_p", "parameters", "p", `"0"`},
		{"negative_k", "parameters", "k", `"-1"`},
		{"too_large_d", "parameters", "d", `"50.00000000000000000001"`},
		{"standard_p_mismatch", "parameters", "p", `"4.5"`},
		{"standard_k_mismatch", "parameters", "k", `"5.5"`},
		{"standard_d_mismatch", "parameters", "d", `"3.5"`},
		{"standard_p_rounded_to_default", "parameters", "p", `"4.00000000000000000001"`},
		{"standard_k_rounded_to_default", "parameters", "k", `"5.00000000000000000001"`},
		{"standard_d_rounded_to_default", "parameters", "d", `"3.00000000000000000001"`},
		{"numeric_parameter", "parameters", "p", `4`},
		{"boolean_parameter", "parameters", "k", `true`},
		{"unknown_root_field", "root", "unexpected", `true`},
		{"obsolete_algorithm_version", "root", "algorithm_version", `"old"`},
		{"unknown_base_field", "base", "unexpected", `true`},
		{"unknown_point_field", "point", "unexpected", `true`},
		{"unknown_parameter_field", "parameters", "unexpected", `true`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := alteredRequest(t, test.section, test.field, test.value)
			assertAPIError(t, performCalculation(t, body), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
		})
	}
}

func TestHandlerRejectsInvalidGridAndCombinedFlags(t *testing.T) {
	tests := []struct {
		name   string
		change func(*CalculateRequest)
	}{
		{"both_flags_true", func(r *CalculateRequest) {
			r.Base.Points[0].IsInterpolated = boolPointer(true)
			r.Base.Points[0].IsExtrapolated = boolPointer(true)
		}},
		{"duplicate_labels", func(r *CalculateRequest) {
			point := r.Base.Points[0]
			point.TenorYears = "1"
			r.Base.Points = append(r.Base.Points, point)
		}},
		{"duplicate_tenors", func(r *CalculateRequest) {
			point := r.Base.Points[0]
			point.BucketLabel = "other"
			r.Base.Points = append(r.Base.Points, point)
		}},
		{"descending_tenors", func(r *CalculateRequest) {
			point := r.Base.Points[0]
			point.BucketLabel = "earlier"
			point.TenorYears = "0.01"
			r.Base.Points = append(r.Base.Points, point)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validCalculationRequest()
			test.change(&request)
			assertAPIError(t, performCalculation(t, marshalRequest(t, request)), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
		})
	}
}

func TestHandlerRejectsMalformedJSON(t *testing.T) {
	valid := marshalRequest(t, validCalculationRequest())
	tests := []struct {
		name string
		body string
	}{
		{"empty", ""},
		{"truncated", `{"base":`},
		{"trailing_comma", `{"base":{},}`},
		{"multiple_objects", string(valid) + `{}`},
		{"trailing_garbage", string(valid) + ` garbage`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertAPIError(t, performCalculation(t, []byte(test.body)), http.StatusBadRequest, "INVALID_JSON")
		})
	}
}

func TestCalculationFailureResponse(t *testing.T) {
	// The handler hard-codes Calculate. Exercise its error writer directly instead
	// of changing production code just to inject an otherwise unreachable failure.
	recorder := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, calculationPath, nil)
	handleCalculateError(recorder, request, errors.New("calculation failed"), slog.Default())
	assertAPIError(t, recorder, http.StatusInternalServerError, "CALCULATION_FAILED")
}

func validCalculationRequest() CalculateRequest {
	return CalculateRequest{
		Base: BaseCurveRequest{
			CurveCode: "base",
			Points: []BasePointRequest{{
				BucketLabel: "1m", TenorYears: "0.041700", RatePercent: "14.45",
				IsInterpolated: boolPointer(false), IsExtrapolated: boolPointer(false),
			}},
		},
		Parameters: ParametersRequest{Mode: "standard", P: "4", K: "5", D: "3"},
	}
}

func boolPointer(value bool) *bool { return &value }

func marshalRequest(t *testing.T, request CalculateRequest) []byte {
	t.Helper()
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func performCalculation(t *testing.T, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	recorder := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, calculationPath, strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")
	NewHandler(logger).ServeHTTP(recorder, request)
	return recorder
}

type stressResponseCurve struct {
	Code   string                       `json:"curve_code"`
	Points []map[string]json.RawMessage `json:"points"`
}

func assertStressResponse(t *testing.T, recorder *httptest.ResponseRecorder, request CalculateRequest, expected map[string][]float64) {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected content type: %q", recorder.Header().Get("Content-Type"))
	}
	var response struct {
		Curves []stressResponseCurve `json:"curves"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Curves) != len(expectedStressCodes) {
		t.Fatalf("got %d curves, want six", len(response.Curves))
	}
	remaining := make(map[string]bool, len(expectedStressCodes))
	for _, code := range expectedStressCodes {
		remaining[code] = true
	}
	for _, curve := range response.Curves {
		if !remaining[curve.Code] {
			t.Fatalf("unexpected or duplicate curve code: %q", curve.Code)
		}
		delete(remaining, curve.Code)
		assertStressCurve(t, curve, request.Base.Points, expected)
	}
}

func assertStressCurve(t *testing.T, curve stressResponseCurve, base []BasePointRequest, expected map[string][]float64) {
	t.Helper()
	if len(curve.Points) != len(base) {
		t.Fatalf("%s: grid size changed", curve.Code)
	}
	if expected != nil && len(expected[curve.Code]) != len(curve.Points) {
		t.Fatalf("%s: expected rates are incomplete", curve.Code)
	}
	for i, point := range curve.Points {
		rate := assertStressPoint(t, point, base[i])
		if expected != nil {
			want := expected[curve.Code][i]
			tolerance := httpAbsoluteTolerance + httpRelativeTolerance*math.Abs(want)
			if math.Abs(rate-want) > tolerance {
				t.Errorf("%s point %d: rate %.17g, want %.17g within %.3g", curve.Code, i, rate, want, tolerance)
			}
		}
	}
}

func assertStressPoint(t *testing.T, point map[string]json.RawMessage, base BasePointRequest) float64 {
	t.Helper()
	for _, field := range []string{"is_interpolated", "is_extrapolated"} {
		if _, present := point[field]; present {
			t.Errorf("stress point contains provenance field %q", field)
		}
	}
	if len(point) != 3 {
		t.Errorf("stress point must contain only bucket_label, tenor_years and rate_percent: %v", point)
	}
	var label, tenor, rateString string
	for field, target := range map[string]*string{
		"bucket_label": &label, "tenor_years": &tenor, "rate_percent": &rateString,
	} {
		if err := json.Unmarshal(point[field], target); err != nil {
			t.Fatalf("%s must be a JSON string: %v", field, err)
		}
	}
	if label != base.BucketLabel || tenor != base.TenorYears {
		t.Errorf("grid changed: got (%q, %q), want (%q, %q)", label, tenor, base.BucketLabel, base.TenorYears)
	}
	rate, err := strconv.ParseFloat(rateString, 64)
	if err != nil || math.IsNaN(rate) || math.IsInf(rate, 0) {
		t.Fatalf("invalid output rate %q: %v", rateString, err)
	}
	return rate
}

func assertAPIError(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, status, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected content type: %q", recorder.Header().Get("Content-Type"))
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	var gotCode, message string
	if err := json.Unmarshal(body["code"], &gotCode); err != nil || gotCode != code {
		t.Errorf("error code = %s, want %q", body["code"], code)
	}
	if err := json.Unmarshal(body["message"], &message); err != nil || strings.TrimSpace(message) == "" {
		t.Errorf("missing error message: %s", body["message"])
	}
	var details []json.RawMessage
	if err := json.Unmarshal(body["details"], &details); err != nil || details == nil {
		t.Errorf("details must be a JSON array: %s", body["details"])
	}
	if _, partial := body["curves"]; partial {
		t.Error("error response contains partial curves")
	}
}

func alteredRequest(t *testing.T, section, field, value string) []byte {
	t.Helper()
	decode := func(data []byte) map[string]json.RawMessage {
		t.Helper()
		var object map[string]json.RawMessage
		if err := json.Unmarshal(data, &object); err != nil {
			t.Fatal(err)
		}
		return object
	}
	encode := func(value any) []byte {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	root := decode(marshalRequest(t, validCalculationRequest()))
	base := decode(root["base"])
	parameters := decode(root["parameters"])
	var points []json.RawMessage
	if err := json.Unmarshal(base["points"], &points); err != nil {
		t.Fatal(err)
	}
	point := decode(points[0])
	target := root
	switch section {
	case "root":
	case "base":
		target = base
	case "parameters":
		target = parameters
	case "point":
		target = point
	default:
		t.Fatalf("unknown request section %q", section)
	}
	if value == "" {
		delete(target, field)
	} else {
		target[field] = json.RawMessage(value)
	}
	if section == "point" {
		points[0] = encode(point)
		base["points"] = encode(points)
	}
	if section == "base" || section == "point" {
		root["base"] = encode(base)
	}
	if section == "parameters" {
		root["parameters"] = encode(parameters)
	}
	return encode(root)
}
