package httpapi

import (
	"encoding/json"
	"os"
	"testing"
)

func TestHandlerBaseCurveContract(t *testing.T) {
	// Python verifies that this shared payload is actual build_base_curve output.
	// Exercise the unmodified JSON through the Go consumer, including all flags.
	data, err := os.ReadFile("../../../base/examples/stress-request.json")
	if err != nil {
		t.Fatal(err)
	}
	var request CalculateRequest
	if err := json.Unmarshal(data, &request); err != nil {
		t.Fatal(err)
	}
	assertStressResponse(t, performCalculation(t, data), request, nil)
}
