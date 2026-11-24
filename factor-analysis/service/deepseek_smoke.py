"""Opt-in check of the real DeepSeek URL using an aggregate synthetic report."""

import argparse
from pathlib import Path

from .config import load_env
from .explanations import explain
from .llm import provider


def main(argv=None):
    parser = argparse.ArgumentParser(description='Проверка DeepSeek на синтетических фактах.')
    parser.add_argument('--live', action='store_true', help='Выполнить платный запрос к реальному API.')
    if not parser.parse_args(argv).live:
        parser.error('Для реального запроса укажите --live.')
    load_env(Path(__file__).resolve().parents[1])
    current = provider()
    if current.name != 'deepseek' or current.status != 'available':
        parser.exit(2, 'Для этой проверки настройте DeepSeek, задайте ключ и разрешите облачный запрос.\n')
    workspace = {'source': 'integrated', 'portfolioSource': 'synthetic', 'report': {
        'mode': 'valuation', 'target': 'npv', 'unit': '₽', 'before': '2025-01-31', 'after': '2025-02-28',
        'start': 1200, 'end': 1285, 'change': 85, 'matched': 10, 'additions': 15, 'exclusions': -10,
        'factors': [{'key': 'cash_effect', 'value': 100}, {'key': 'discount_effect', 'value': -20}],
        'joint': -5, 'reconciliation': 0, 'warnings': [], 'interactions': [],
    }}
    answer = explain(workspace, 'Как изменился NPV?')
    if answer['mode'] == 'llm' and answer['provider'] == 'deepseek' and answer['facts']:
        print('DeepSeek вернул проверенный план для синтетического отчёта.')
        return 0
    print(f'Проверка DeepSeek не пройдена. Статус {answer["status"]}. Доступно локальное объяснение.')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
