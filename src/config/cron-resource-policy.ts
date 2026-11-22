const MAX_INPUT_CHARACTERS = 1024;
const MAX_RANGE_VALUES = 512;
const FIELD_DOMAINS = [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'] as const;
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

function replaceNames(field: string, names: readonly string[], first: number): string {
  // Same two passes/order as the installed converter: full names, then three-letter names.
  for (const short of [false, true]) {
    for (const [index, name] of names.entries()) {
      field = field.replace(new RegExp(short ? name.slice(0, 3) : name, 'gi'), String(first + index));
    }
  }
  return field;
}

/** Total over unknown input; no expansion, filesystem access or scheduler dependency. */
export function isCronValidationWorkBounded(input: unknown): boolean {
  if (typeof input !== 'string' || input.length > MAX_INPUT_CHARACTERS) return false;
  const fields = input.replace(/\s{2,}/g, ' ').trim().split(' ');
  if (fields.length === 5) fields.unshift('0');
  if (fields.length !== 6) return false;
  fields[4] = replaceNames(fields[4], MONTH_NAMES, 1);
  // node-cron replaces only the first substring 7, before names. Preserve that order.
  fields[5] = replaceNames(fields[5].replace('7', '0'), WEEKDAY_NAMES, 0);

  let reservedValues = 0;
  for (const [index, [min, max]] of FIELD_DOMAINS.entries()) {
    // Only the first wildcard is replaced by node-cron. Its weekday wildcard is 0-6.
    const field = fields[index].replace('*', `${min}-${index === 5 ? 6 : max}`);
    for (const character of field) {
      if (character === '-') reservedValues += max - min + 1;
      if (reservedValues > MAX_RANGE_VALUES) return false;
    }
    for (const match of field.matchAll(/(\d+)-(?=(\d+))/g)) {
      for (const endpoint of [Number(match[1]), Number(match[2])]) {
        if (!Number.isSafeInteger(endpoint) || endpoint < min || endpoint > max) return false;
      }
    }
  }
  return true;
}
