/** 混合 tokenizer：拉丁/數字連段當 word token；CJK 連段切 character bigram（單字保留）。
 *  BM25 與 FakeEmbedder 共用，讓「王經理」這類專有名詞能精確匹配。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /[a-z0-9_]+|[㐀-䶿一-鿿]+/g;
  for (const m of text.toLowerCase().matchAll(re)) {
    const s = m[0];
    if (/[a-z0-9_]/.test(s[0]!)) {
      tokens.push(s);
    } else if (s.length === 1) {
      tokens.push(s);
    } else {
      for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2));
    }
  }
  return tokens;
}
