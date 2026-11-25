export function snapshotDates(lastDate, count) {
  const last = new Date(lastDate + 'T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    if (index === count - 1) return lastDate;
    const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - count + index + 2, 0));
    while (end.getUTCDay() === 0 || end.getUTCDay() === 6) end.setUTCDate(end.getUTCDate() - 1);
    return end.toISOString().slice(0, 10);
  });
}
