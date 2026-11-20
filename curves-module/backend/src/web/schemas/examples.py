"""Illustrative one-bucket response for the standard-result operation."""

STANDARD_RESULT_EXAMPLE = {
    "reportDate": "2026-07-31",
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "runOrigin": "manual",
    "dataProvenance": "synthetic",
    "source": "moex",
    "completedAt": "2026-07-31T16:00:00Z",
    "usedParameters": {"mode": "standard", "p": 4, "k": 5, "d": 3},
    "curves": [
        {
            "curveCode": code,
            "points": [
                {
                    "bucketLabel": "1y",
                    "tenorYears": 1,
                    "ratePercent": rate,
                    "discountFactor": factor,
                }
            ],
        }
        for code, rate, factor in (
            ("base", 10, 0.904837418036),
            ("parallel_up", 14, 0.869358235399),
            ("parallel_down", 6, 0.941764533584),
            ("steepener", 8.066135340725, 0.922506042081),
            ("flattener", 12.717044541814, 0.880583568371),
            ("short_rate_up", 13.894003915357, 0.870280209632),
            ("short_rate_down", 6.105996084643, 0.940766828909),
        )
    ],
}
