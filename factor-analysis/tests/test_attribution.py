import csv
import io
import json
import math
import unittest

from service.attribution import analyze
from service.explanations import fact_library, scope
from service.panel import extract_csv, profile_column


def synthetic_history():
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";")
    writer.writerow(["дата", "сделка", "value", "exposure", "rate", "kind", "constant", "upstream_id"])
    for month in range(1, 7):
        for i in range(month - 1, 80 + month * 2):
            exposure = 10 + (i * 7 + month) % 50
            rate = (i % 11) / 10
            category = "fixed" if i % 2 == 0 else "float"
            value = exposure + 70 * rate ** 2 + (140 * rate if category == "float" else 0)
            writer.writerow([f"2026-{month:02d}-25", i, value, exposure, rate, category, 1, i * 101])
    return extract_csv(out.getvalue())


class AttributionTest(unittest.TestCase):
    config = {"dateColumn": "дата", "idColumn": "сделка", "target": "value"}

    @classmethod
    def setUpClass(cls):
        cls.panel = synthetic_history()
        cls.report = analyze(cls.panel, cls.config)

    def test_explains_a_portfolio_change_and_reconciles(self):
        result = self.report
        self.assertEqual(set(result["selectedFeatures"]), {"exposure", "rate", "kind"})
        self.assertEqual((result["added"], result["removed"]), (2, 1))
        modeled = math.fsum(item["value"] for item in result["factors"])
        self.assertAlmostEqual(
            result["change"], modeled + result["additions"] + result["exclusions"] + result["residual"],
            places=7,
        )
        json.dumps(result, allow_nan=False)

    def test_detects_pairwise_interaction_and_validates_out_of_time(self):
        result = self.report
        strongest = result["interactions"][0]
        self.assertEqual({strongest["a"], strongest["b"]}, {"rate", "kind"})
        self.assertGreater(strongest["strength"], 2)
        self.assertTrue(all(row["trainedThrough"] < row["date"] for row in result["quality"]))
        self.assertTrue(all(day < result["before"] for day in result["trainingDates"]))
        self.assertLess(sum(row["forest"] for row in result["quality"]), sum(row["linear"] for row in result["quality"]))
        effects = next(row for row in result["effects"] if row["key"] == "rate")
        self.assertGreaterEqual(len(effects["points"]), 3)

    def test_insufficient_history_keeps_the_observed_residual(self):
        settings = {**self.config, "before": "2026-01-25", "after": "2026-02-25"}
        report = analyze(self.panel, settings)
        self.assertFalse(report["reliable"])
        self.assertTrue(report["warnings"])
        self.assertFalse(report["factors"])
        self.assertAlmostEqual(report["change"], report["additions"] + report["exclusions"] + report["residual"])

    def test_duplicate_id_per_date_is_rejected(self):
        duplicated = extract_csv("date,id,x\n2026-01-01,A,1\n2026-01-01,A,2\n2026-02-01,A,3")
        with self.assertRaisesRegex(ValueError, "повторяется"):
            analyze(duplicated, {"dateColumn": "date", "idColumn": "id", "target": "x"})

    def test_explanation_fact_units_follow_the_dataset(self):
        facts = fact_library(self.report, {}, "")
        self.assertNotIn("₽", facts["overview"]["text"])
        self.assertEqual(facts["quality"]["source"], "#quality")

    def test_explanation_scope_keeps_pairs_and_quality_relevant(self):
        facts = fact_library(self.report, {}, "")
        catalog, required = scope(facts, "Есть ли взаимодействие факторов?")
        self.assertEqual(required, ["pair_0"])
        self.assertNotIn("overview", catalog)
        self.assertEqual(scope(facts, "Какая ошибка у модели?")[1], ["quality"])
        self.assertEqual(scope(facts, "Сколько стоит яблоко?"), ([], []))

    def test_profile_flags_an_outlier_without_removing_rows(self):
        column = profile_column("principal", ["1", "2", "3", "4", "5", "7", "60", ""])
        self.assertEqual((column.missing, column.distinct, column.outliers), (1, 7, 1))


if __name__ == "__main__":
    unittest.main()
