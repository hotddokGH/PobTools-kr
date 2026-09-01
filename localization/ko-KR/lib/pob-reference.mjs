function decodeLuaString(text) {
  return text.replace(/\\(\d{1,3}|[\\"nrt])/g, (escape, token) => {
    if (/^\d+$/.test(token)) return String.fromCharCode(Number(token));
    return { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' }[token] ?? escape;
  });
}

function sortedObject(entries, locale = 'en') {
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right, locale)));
}

export function extractKoreanTranslationTables(luaText) {
  const headerPattern = /^KoreanTranslation\.([A-Za-z0-9_]+)\s*=\s*\{/gm;
  const headers = [...String(luaText).matchAll(headerPattern)];
  const tables = [];

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const end = headers[index + 1]?.index ?? luaText.length;
    const section = luaText.slice(header.index + header[0].length, end);
    const entries = new Map();
    const pairPattern = /^\s*\["((?:\\.|[^"\\])*)"\]\s*=\s*"((?:\\.|[^"\\])*)"/gm;
    for (const pair of section.matchAll(pairPattern)) {
      const key = decodeLuaString(pair[1]);
      const value = decodeLuaString(pair[2]);
      if (entries.has(key) && entries.get(key) !== value) {
        throw new Error(`conflicting Korean reference value: ${key}`);
      }
      entries.set(key, value);
    }
    tables.push([header[1], sortedObject([...entries])]);
  }

  return sortedObject(tables);
}
