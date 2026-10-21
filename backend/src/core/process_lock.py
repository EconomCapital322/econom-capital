"""Single-host POSIX process locks, independent of database connections."""

import fcntl
import hashlib
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def process_lock(key: str) -> Iterator[bool]:
    digest = hashlib.sha256(key.encode()).hexdigest()
    path = Path(tempfile.gettempdir()) / f"irrbb-{digest}.lock"
    # Do not unlink: another process could otherwise lock a different inode.
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    acquired = False
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            pass
        yield acquired
    finally:
        if acquired:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)
