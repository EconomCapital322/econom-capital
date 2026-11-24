"""Opt-in check of the real DeepSeek URL using an aggregate synthetic report."""

import argparse
from pathlib import Path

from .config import load_env
from .explanations import explain
from .llm import provider


def main(argv=None):
    parser = argparse.ArgumentParser(description='Проверка DeepSeek на синтетических фактах.')
    parser.add_argument('--live', action='store_true', help='Выполнить платный запрос к реальному API.')
    parser.add_argument('--case', choices=('valuation', 'ml'), default='valuation')
    args = parser.parse_args(argv)
    if not args.live:
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
    question = 'Что потянуло NPV вверх?'
    if args.case == 'ml':
        workspace['report'].update(mode='ml', status='caution', reliable=False, residual=19,
            factors=[{'key': 'principal', 'value': 72}, {'key': 'contract_rate', 'value': -11}],
            warnings=['Проверочные ошибки модели выше медианного ориентира.'],
            effects=[{'key': 'principal', 'kind': 'numeric', 'shape': 'u', 'shapeLabel': 'U-образная',
                      'support': 85, 'range': [200, 1500], 'turningRange': [650, 800], 'stability': .82}])
        question = 'Какую форму зависимости выявили для остатка долга?'
    answer = explain(workspace, question, allow_external=True)
    expected = ('shape',) if args.case == 'ml' else ('rise', 'largest_positive', 'positive', 'offset')
    if answer['mode'] == 'llm' and answer['provider'] == 'deepseek' \
            and any(item.get('claimType') in expected for item in answer['facts']):
        print('DeepSeek вернул проверенное объяснение для синтетического отчёта.')
        for item in answer['facts']:
            print(item['text'])
        return 0
    if answer['mode'] == 'llm':
        print('DeepSeek вернул проверенные факты. В ответе отсутствует проверяемая формулировка для этого сценария.')
        return 1
    print(f'Проверка DeepSeek не пройдена. Статус {answer["status"]}. Доступно локальное объяснение.')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
