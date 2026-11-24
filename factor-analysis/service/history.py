"""Import and export a bounded collection of calculator snapshots."""

from collections import defaultdict
from decimal import Decimal
from io import BytesIO
import json
from pathlib import PurePosixPath
import re
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from .integration import discount_flows, read_rows, summarize, write_rows
from .valuation import FILES, METHOD, load_snapshot, report_date

MAX_ARCHIVE = 16_000_000
MAX_EXPANDED = 96_000_000
FORMAT = 'spectrum-snapshots-v1'
DAY = re.compile(r'\d{4}-\d{2}-\d{2}')


def classify(value):
    if value == 'synthetic':
        return 'synthetic'
    if value == 'bank':
        return 'bank'
    return 'external'


def pack(folder, periods, provenance):
    buffer = BytesIO()
    with ZipFile(buffer, 'w', compression=ZIP_DEFLATED, compresslevel=4) as archive:
        archive.writestr('manifest.json', json.dumps({'format': FORMAT, 'method': METHOD, 'portfolioSource': classify(provenance),
                         'dates': [{key: item[key] for key in ('date', 'runId', 'sha256')} for item in periods]}))
        expanded = 0
        for period in periods:
            day = report_date(period['date']).isoformat()
            for name in FILES:
                entry = folder / day / name
                expanded += entry.stat().st_size
                if expanded > MAX_EXPANDED:
                    raise ValueError('История слишком велика для ZIP. Выгрузите файлы по датам.')
                archive.write(entry, f'{day}/{name}')
    result = buffer.getvalue()
    if len(result) > MAX_ARCHIVE:
        raise ValueError('История слишком велика для ZIP. Выгрузите файлы по датам.')
    return result


def unpack(raw, folder, update):
    if len(raw) > MAX_ARCHIVE:
        raise ValueError('Импортируйте ZIP размером до 16 МБ.')
    try:
        with ZipFile(BytesIO(raw)) as archive:
            entries = defaultdict(set)
            seen = set()
            files = [entry for entry in archive.infolist() if not entry.is_dir()]
            if len(files) > 12 * len(FILES) + 1 or sum(entry.file_size for entry in files) > MAX_EXPANDED:
                raise ValueError('В ZIP допускается не более 12 дат и 96 МБ распакованных данных.')
            for member in files:
                name = member.filename
                if name in seen or member.flag_bits & 1:
                    raise ValueError('В ZIP повторяются файлы или используется шифрование.')
                seen.add(name)
                if name == 'manifest.json':
                    continue
                day, _, relative = name.partition('/')
                if not DAY.fullmatch(day) or relative not in FILES or str(PurePosixPath(name)) != name:
                    raise ValueError('Структура ZIP должна содержать отчётные даты и только совместимые файлы.')
                report_date(day)
                entries[day].add(relative)
            if not 2 <= len(entries) <= 12 or any(paths != set(FILES) for paths in entries.values()):
                raise ValueError('В ZIP нужны два или более полных снимка. Посмотрите пример в README.')
            manifest = json.loads(archive.read('manifest.json')) if 'manifest.json' in seen else {}
            if not isinstance(manifest, dict) or (manifest and (manifest.get('format') != FORMAT or manifest.get('method') != METHOD)):
                raise ValueError('Неизвестная версия истории или методики.')
            checks = {}
            if manifest:
                dates = manifest.get('dates')
                if not isinstance(dates, list) or any(not isinstance(item, dict) or not isinstance(item.get('date'), str) for item in dates):
                    raise ValueError('Проверьте даты в манифесте истории.')
                checks = {item['date']: item for item in dates}
                if len(checks) != len(dates) or set(checks) != set(entries):
                    raise ValueError('Список дат в манифесте не совпадает с файлами.')
            for day, paths in entries.items():
                for part in paths:
                    target = folder / day / part
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(f'{day}/{part}'))
    except (BadZipFile, RuntimeError, UnicodeError, NotImplementedError) as error:
        raise ValueError('ZIP повреждён или использует неподдерживаемый формат.') from error

    dataset, periods, ids = [], [], set()
    for i, day in enumerate(sorted(entries)):
        update(i, len(entries), f'{day} · проверка выгрузок калькулятора и кривых')
        snapshot = load_snapshot(folder, day)
        if day in checks and any(checks[day].get(key) != snapshot.source[key] for key in ('runId', 'sha256')):
            raise ValueError(f'{day}. Снимок кривых не совпадает с контрольной суммой или ID в манифесте.')
        root = folder / day
        inputs = root / FILES[0]
        core = root / 'core'
        contracts = {row['deal_id']: row for row in read_rows(inputs, ';')}
        flows = read_rows(root / FILES[1])
        saved_pv = (root / FILES[3]).read_bytes()
        curves = json.loads((root / FILES[-1]).read_bytes(), parse_float=Decimal)
        discount_flows(core, inputs, curves, 'all')
        (root / FILES[3]).write_bytes(saved_pv)
        try:
            rows, metrics = summarize(report_date(day), contracts, curves, core, flows, 'parallel_up')
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f'{day}. Входной файл не соответствует нормализованной схеме калькулятора v1.') from error
        dataset.extend(rows)
        if len(dataset) > 20_000:
            raise ValueError('Суммарно во всех снимках допускается до 20 000 сделок × дат.')
        ids.update(contracts)
        periods.append({**metrics, **snapshot.source, 'deals': len(contracts), 'flowRows': len(flows),
                        'curveSource': 'fixture' if curves.get('source') == 'synthetic_fixture' else 'imported'})
    write_rows(folder / 'dataset.csv', dataset, dataset[0].keys())
    return {'source': 'historical', 'portfolioSource': classify(manifest.get('portfolioSource')), 'periods': periods,
            'scenario': 'parallel_up', 'uniqueDeals': len(ids), 'snapshotCount': len(dataset), 'method': METHOD}
