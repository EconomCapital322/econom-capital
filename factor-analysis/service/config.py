"""Read the optional local settings file as literal KEY=value entries."""

import os
import re


def load_env(folder):
    for name in ('.env.local', '.env'):
        path = folder / name
        if not path.is_file():
            continue
        for line in path.read_text(encoding='utf-8').splitlines():
            key, separator, value = line.strip().partition('=')
            if separator and re.fullmatch(r'(?:SPECTRUM|DEEPSEEK)_[A-Z0-9_]+', key):
                value = value.strip()
                if value[:1] in ('"', "'") and value[-1:] == value[:1]:
                    value = value[1:-1]
                os.environ.setdefault(key, value)
