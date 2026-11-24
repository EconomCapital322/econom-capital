"""Select what can cross the external model boundary."""

import os
import re

BANK_FIELDS = frozenset({
    'metric.start', 'metric.end', 'metric.change', 'composition.added', 'composition.removed',
    'validation.reconciliation', 'model.residual', 'data.profile', 'data.missing', 'data.outliers',
    'data.history', 'factor.direction',
})
BLOCKED = re.compile(
    r'https?://|[\w.+-]+@[\w.-]+\.[a-zа-я]+|sk-[a-z0-9_-]{8,}|(?:\d[\s()-]*){5,}|'
    r'\b(?:iban|паспорт|снилс|телефон|аккаунт|клиент[а-я]*|адрес[а-я]*)\b|'
    r'ignore|override|system prompt|инструкц|секрет|api.?ключ|парол|<[/!]|\{\{',
    flags=re.IGNORECASE,
)
# Exact public words only. Unknown tokens, digits, identifiers and metadata never get copied as text.
QUESTION_WORDS = frozenset("""
npv pv mae rmse shap ale ice pdp delta p k d ml
а без был была были было более больше в вам вас вместе влияние влияет влияют вырос выросла выросло выросли
где да для до должны доходность его её ее если есть ещё еще за и из или итого итог какую какая какие каким каким
каких какое какой как кто когда к куда ли между мне мог можно мы на наибольший нам насколько наш не нет ни
но нулевой о об один она они оно основание от перед по почему поясни прежде при про расскажи рассчитай
с самый сейчас сколько со сравни так такие там тем тогда то тут у уже чем через что чтобы эти этим это этом этот
главные главных главный главное драйвер драйверы ключевые сравнение разница сумма вместе отдельно подробнее
после начальное конечное начало конец период периода дат дата даты отчётная отчетная результат результата
результаты отчёт отчет вывод выводы резюме сводку объясни объяснить объясняет объяснили показать
доверять доверие надёжный надежный надёжен надежен надёжность надежность устойчивость устойчивы качество оценка
оценки оценку экономический экономическая смысл моделирует модель модели прогноз точность проверка сверка
проверить ошибка ошибки временная валидация источник источники базовый база базовая базой медиана медианный
качество исходный остаток необъяснённый необъясненный изменил изменилась изменился изменилось изменения
изменение вклад вкладом вклады вклада вкладов основной основных наибольшие наибольшего отрицательный
отрицательные положительный положительные повысился снизился снизилась снижение рост выросли упал упала
уменьшился увеличился увеличилась просел просела просело просадку тянул потянул вытянул разогнал подтолкнул
дороже дешевле величина насколько фактор фактора факторов факторы эффект эффекты эффектов вместе совместный
совместное совместно взаимодействие взаимодействия взаимодействуют взаимодействующий сила знак компенсировал
компенсировали компенсирует нелинейность нелинейная нелинейные нелинейных нелинейный насыщение насыщения
зависимость зависимости диапазон диапазоне форма форму порог порога максимум минимум убывает возрастает
платежи платежей платежам платеж договор договорный договорные договорных параметр параметры остатка долга
погашение погашения погашениям процентные проценты денежные денежных поток потоки потоков потоком перевод
перенос срок сроков сроки срока день месяц год короткие длинные ставок ставка ставки кривой кривые кривую кривая
дисконт коэффициенты коэффициент дисконтирования сценарий сценарии сценариев шок стресс стресса стрессовый
стрессовые чувствительность портфель портфеля портфеле состав составе сделки сделок сделку сделках новые
новых выбывшие выбывших появившиеся поступили ушли исключили тип типы классы распределение
признак признаки признаков признака метрика метрики показатель показателя значения важность глобальная
глобальную локальная локальный исключение исключения исключены выбран выбраны выбор выбрала отобрали взяли
пропуски выбросы утечка утечку история истории недостаточно состояние состояния контрфактические разложение
формула методу метод методология методику пороговый западание просадка толкнуло двинуло держит поменялось
график графика уровень уровни проценты провал подъём подъем стоил стоимость стоимости здраво разумно
вверх вниз потянуло куда мы вышли откуда вышел неблагоприятный неблагоприятная короткий длинный означают
распределяются приходится было бы открывает выбраны проверены пригоден можно ли довериться
доля долю составил составила чистого точнее надёжно надежно устойчивость подпись
""".split())


def screen_question(question):
    if BLOCKED.search(question):
        return None
    lowered = question.casefold().replace('ё', 'е')
    # Preserve order and question emphasis while dropping unapproved words, punctuation and numbers.
    known = {word.replace('ё', 'е') for word in QUESTION_WORDS}
    return ' '.join(word for word in re.findall(r'[a-zа-я]+', lowered) if word in known)[:240]


def policy(workspace, *, public=False):
    if public or (workspace.get('source') == 'integrated' and workspace.get('portfolioSource') == 'synthetic'):
        return 'aggregate', BANK_FIELDS
    allowed = BANK_FIELDS & {field.strip() for field in os.environ.get('SPECTRUM_AI_BANK_FIELDS', '').split(',')}
    return ('restricted', allowed) if allowed else ('forbidden', allowed)


def select_permissions(facts, access, allowed):
    if access != 'restricted':
        return facts, {key: key for key in facts}
    selected, aliases = {}, {}
    factor = 0
    for key, item in facts.items():
        if key in allowed:
            selected[key], aliases[key] = item, key
        elif 'factor.direction' in allowed and key.startswith('factor.') and item['group'] == 'contribution':
            factor += 1
            selected[key], aliases[key] = item, f'factor.feature_{factor}'
    return selected, aliases


def provider_fact(key, fact, access):
    value = fact['value']
    direction = ('positive' if value > 0 else 'negative' if value < 0 else 'zero') if value is not None else None
    if access == 'restricted':
        if key.startswith('factor.'):
            return {'kind': 'contribution', 'direction': direction}
        # Field ID conveys the business category. Omit arbitrary labels, units, dates and other metadata.
        return {'kind': fact['group'] or key, 'direction': direction, 'value': value} if value is not None else {'kind': key}
    return {name: val for name, val in {
        'title': fact['title'], 'kind': fact['group'], 'value': value, 'direction': direction, 'unit': fact['unit'],
        'meaning': fact['meaning'], 'metadata': fact['meta'], 'source': fact['source'],
    }.items() if val or val == 0}
