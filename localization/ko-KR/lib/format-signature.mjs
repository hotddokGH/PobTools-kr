export function formatSignature(text) {
  const tokens = [];
  for (const match of String(text).matchAll(/%(?:[-+0 #]*\d*(?:\.\d+)?)?[A-Za-z](?![A-Za-z])/g)) {
    tokens.push(`PRINTF:${match[0]}`);
  }
  for (const match of String(text).matchAll(/\{\d*(?::[^{}\s]+)?\}/g)) {
    tokens.push(`SLOT:${match[0]}`);
  }
  for (const match of String(text).matchAll(/\^(?:x[0-9A-Fa-f]{6}|\d)/g)) {
    tokens.push(`TAG:${match[0]}`);
  }
  for (let index = 0; index < (String(text).match(/\n/g)?.length ?? 0); index += 1) {
    tokens.push('LF');
  }
  return tokens.sort();
}
