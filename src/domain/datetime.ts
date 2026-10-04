export function zonedInput(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
export function inputToInstant(value: string, timezone: string) {
  const target = new Date(value + ':00Z').getTime();
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const local = zonedInput(new Date(candidate).toISOString(), timezone);
    const difference = target - new Date(local + ':00Z').getTime();
    candidate += difference;
    if (difference === 0) break;
  }
  if (zonedInput(new Date(candidate).toISOString(), timezone) !== value)
    throw new Error('L’orario non esiste in questo fuso orario. Controlla il cambio dell’ora.');
  return new Date(candidate).toISOString();
}
