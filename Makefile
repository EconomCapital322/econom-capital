.PHONY: configure up down logs calculate check check-factor-analysis
SPECTRUM_TEST_PYTHON ?= $(if $(wildcard .venv/bin/python),$(abspath .venv/bin/python),python3)
configure:
	@test -f curves-module/.env || cp curves-module/.env.example curves-module/.env
up: configure
	docker compose --profile calculator build calculator
	docker compose up -d --build --wait
calculate: configure
	docker compose --profile calculator run --rm calculator $(ARGS)
down:
	docker compose --profile calculator down
logs:
	docker compose logs -f --tail=100
check:
	$(MAKE) -C curves-module check
	cmake -S calculator -B calculator/build -DCMAKE_BUILD_TYPE=Release
	cmake --build calculator/build -j2
	ctest --test-dir calculator/build --output-on-failure
	CFCORE_BIN="$(CURDIR)/calculator/build/core/cfcore" python3 -m pytest calculator/cf-normalizer/tests -q
	$(MAKE) check-factor-analysis
check-factor-analysis:
	@test -n "$$SPECTRUM_CFCORE" || test -x calculator/build/core/cfcore || test -x factor-analysis/.local/bin/cfcore || \
		(cmake -S calculator -B calculator/build -DCMAKE_BUILD_TYPE=Release && cmake --build calculator/build --target cfcore_cli -j 2)
	cd factor-analysis && SPECTRUM_REQUIRE_CORE_IN_TESTS=1 "$(SPECTRUM_TEST_PYTHON)" -m unittest discover -s tests -p 'test_*.py' -v
	cd factor-analysis && node --test tests/integration.test.mjs
