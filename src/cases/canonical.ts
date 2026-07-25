import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot contain a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(',')}}`;
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}.`);
}

export function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

export function strictJsonParse(text: string): unknown {
  let position = 0;
  const whitespace = () => {
    while (position < text.length && /\s/u.test(text[position] ?? '')) position += 1;
  };
  const fail = (message: string): never => {
    throw new Error(`${message} at JSON offset ${position}.`);
  };
  const parseString = () => {
    const start = position;
    if (text[position] !== '"') fail('Expected string');
    position += 1;
    let escaped = false;
    while (position < text.length) {
      const character = text[position++];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') escaped = true;
      else if (character === '"') {
        try {
          return JSON.parse(text.slice(start, position)) as string;
        } catch {
          fail('Malformed JSON string');
        }
      } else if ((character?.charCodeAt(0) ?? 0) < 0x20) {
        fail('Control character in string');
      }
    }
    return fail('Unterminated JSON string');
  };
  const parseValue = (): unknown => {
    whitespace();
    const character = text[position];
    if (character === '"') return parseString();
    if (character === '{') {
      position += 1;
      whitespace();
      const object: Record<string, unknown> = {};
      const seen = new Set<string>();
      if (text[position] === '}') {
        position += 1;
        return object;
      }
      for (;;) {
        whitespace();
        const key = parseString();
        if (seen.has(key)) fail(`Duplicate JSON property ${JSON.stringify(key)}`);
        seen.add(key);
        whitespace();
        if (text[position++] !== ':') fail('Expected colon');
        object[key] = parseValue();
        whitespace();
        const separator = text[position++];
        if (separator === '}') return object;
        if (separator !== ',') fail('Expected comma or closing brace');
      }
    }
    if (character === '[') {
      position += 1;
      whitespace();
      const array: unknown[] = [];
      if (text[position] === ']') {
        position += 1;
        return array;
      }
      for (;;) {
        array.push(parseValue());
        whitespace();
        const separator = text[position++];
        if (separator === ']') return array;
        if (separator !== ',') fail('Expected comma or closing bracket');
      }
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, position)) {
        position += literal.length;
        return value;
      }
    }
    const numberMatch = text.slice(position).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      position += numberMatch[0].length;
      const number = Number(numberMatch[0]);
      if (!Number.isFinite(number)) fail('Invalid JSON number');
      return number;
    }
    return fail('Expected JSON value');
  };
  const value = parseValue();
  whitespace();
  if (position !== text.length) fail('Unexpected trailing content');
  return value;
}
