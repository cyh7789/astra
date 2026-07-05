/** 混合 tokenizer：拉丁/數字連段當 word token；CJK 連段同時發 unigram + bigram。
 *  BM25 與 FakeEmbedder 共用。unigram 必要 — 否則單字 query「王」對「王經理」(bigram 王經/經理)
 *  零交集、BM25 靜默歸零（devin P1）；bigram 讓「王經理」這類專有名詞仍精確匹配。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /[a-z0-9_]+|[㐀-䶿一-鿿]+/g;
  for (const m of text.toLowerCase().matchAll(re)) {
    const s = m[0];
    if (/[a-z0-9_]/.test(s[0]!)) {
      tokens.push(s);
    } else {
      for (const ch of s) tokens.push(ch); // unigram
      for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2)); // bigram
    }
  }
  return tokens;
}
