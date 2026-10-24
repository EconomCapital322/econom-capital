package httpapi

import (
	"strconv"

	"github.com/mrsskaa/curves-module/stress/internal/stress"
)

type BasePointRequest struct {
	BucketLabel    string `json:"bucket_label"`
	TenorYears     string `json:"tenor_years"`
	RatePercent    string `json:"rate_percent"`
	IsInterpolated *bool  `json:"is_interpolated"`
	IsExtrapolated *bool  `json:"is_extrapolated"`
}

type BaseCurveRequest struct {
	CurveCode string             `json:"curve_code"`
	Points    []BasePointRequest `json:"points"`
}

type ParametersRequest struct {
	Mode string `json:"mode"`
	P    string `json:"p"`
	K    string `json:"k"`
	D    string `json:"d"`
}

type StressPointResponse struct {
	BucketLabel string `json:"bucket_label"`
	TenorYears  string `json:"tenor_years"`
	RatePercent string `json:"rate_percent"`
}

type StressCurveResponse struct {
	CurveCode string                `json:"curve_code"`
	Points    []StressPointResponse `json:"points"`
}

type CalculateRequest struct {
	Base       BaseCurveRequest  `json:"base"`
	Parameters ParametersRequest `json:"parameters"`
}

type CalculateResponse struct {
	Curves []StressCurveResponse `json:"curves"`
}

func calculateResponseFromDomain(
	curves []stress.Curve,
	request CalculateRequest,
) CalculateResponse {
	response := CalculateResponse{
		Curves: make([]StressCurveResponse, len(curves)),
	}

	for i, curve := range curves {
		result := StressCurveResponse{
			CurveCode: string(curve.Code),
			Points:    make([]StressPointResponse, len(curve.Points)),
		}

		for j, point := range curve.Points {
			result.Points[j] = StressPointResponse{
				BucketLabel: point.BucketLabel,
				TenorYears:  request.Base.Points[j].TenorYears,
				RatePercent: strconv.FormatFloat(point.RatePercent, 'g', -1, 64),
			}
		}

		response.Curves[i] = result
	}

	return response
}
