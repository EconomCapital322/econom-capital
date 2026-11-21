.PHONY: configure up down logs calculate check
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
